import { Injectable, signal, computed, Optional } from '@angular/core';
import { HttpHeaders } from '@angular/common/http';
import { Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { DatabaseService } from '../../core/database.service';
import { CredentialsService } from '../../core/credentials.service';
import { Release, ReleaseEnrichment, ReleaseTrack } from '../../shared/models/release.model';
import {
  DiscogsMasterRelease,
  DiscogsMasterVersionsResponse,
  DiscogsReleaseDetails,
  conciseDiscogsFormat,
} from './discogs-api.model';
import { DISCOGS_API_DELAY_MS } from '../../shared/constants/timing.constants';
import { DiscogsRequestScheduler } from './discogs-request-scheduler.service';
import { MusicBrainzRequestScheduler } from './musicbrainz-request-scheduler.service';
import { CatalogService } from '../../core/catalog.service';

export interface MasterFetchProgress {
  total: number;
  completed: number;
  inProgress: boolean;
}

export type OriginalYearResolution = 'known' | 'unknown';

export interface ReleaseDetailProgress {
  total: number;
  completed: number;
  inProgress: boolean;
}

interface MusicBrainzReleaseGroup {
  title: string;
  score?: number;
  'first-release-date'?: string;
  'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
}

interface MusicBrainzSearchResponse {
  'release-groups'?: MusicBrainzReleaseGroup[];
}

interface OriginalYearSourceResult {
  year?: number;
  retryable: boolean;
}

const MUSICBRAINZ_NOT_FOUND_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable({
  providedIn: 'root',
})
export class MasterReleaseService {
  private apiUrl = environment.discogsApiUrl;
  private musicBrainzApiUrl = environment.musicBrainzApiUrl;
  private abortController: AbortController | null = null;
  private readonly resolutionRequests = new Map<number, Promise<OriginalYearResolution>>();
  private readonly masterYearRequests = new Map<number, Promise<number | undefined>>();
  private readonly masterRequests = new Map<number, Promise<DiscogsMasterRelease | null>>();
  private readonly albumYearRequests = new Map<string, Promise<OriginalYearSourceResult>>();
  private readonly releaseMetadataRequests = new Map<number, Promise<boolean>>();
  private readonly completedReleaseMetadata = new Set<number>();
  private releaseDetailQueueRunning = false;
  readonly releaseDetailUpdated = new Subject<number>();

  private progressSignal = signal<MasterFetchProgress>({
    total: 0,
    completed: 0,
    inProgress: false,
  });
  private releaseDetailProgressSignal = signal<ReleaseDetailProgress>({
    total: 0,
    completed: 0,
    inProgress: false,
  });

  readonly progress = this.progressSignal.asReadonly();
  readonly isInProgress = computed(() => this.progressSignal().inProgress);
  readonly releaseDetailProgress = this.releaseDetailProgressSignal.asReadonly();

  constructor(
    private db: DatabaseService,
    private credentialsService: CredentialsService,
    private requestScheduler: DiscogsRequestScheduler,
    private musicBrainzScheduler: MusicBrainzRequestScheduler,
    @Optional() private catalogService?: CatalogService,
  ) {}

  private get token(): string {
    return this.credentialsService.getToken() ?? '';
  }

  /**
   * Start fetching master release data in the background
   * Does not block - runs asynchronously
   */
  async startBackgroundFetch(): Promise<void> {
    void this.startReleaseDetailEnrichment();
    if (this.progressSignal().inProgress) {
      console.log('Master fetch already in progress');
      return;
    }

    // Check if master release sync is enabled
    const isEnabled = await this.db.isMasterReleaseSyncEnabled();
    if (!isEnabled) {
      console.log('Master release sync is disabled');
      return;
    }

    this.fetchMasterReleasesInBackground();
  }

  /**
   * Resume background fetch if there are pending releases
   */
  async resumeIfNeeded(): Promise<void> {
    try {
      // Check if master release sync is enabled
      const isEnabled = await this.db.isMasterReleaseSyncEnabled();
      if (!isEnabled) {
        console.log('Master release sync is disabled, not resuming');
        return;
      }

      const pending = await this.db.getReleasesNeedingMasterData();
      if (pending && pending.length > 0 && !this.progressSignal().inProgress) {
        console.log(`Resuming master fetch for ${pending.length} releases`);
        await this.startBackgroundFetch();
      }
    } catch (error) {
      console.error('Failed to check for pending master data:', error);
    }
  }

  /**
   * Stop the background fetch
   */
  stopBackgroundFetch(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.progressSignal.update((p) => ({ ...p, inProgress: false }));
  }

  async resolveOriginalYear(release: Release): Promise<OriginalYearResolution> {
    if (release.basicInfo.originalYear != null) return 'known';

    const request = this.resolutionRequests.get(release.id);
    if (request) return request;

    const resolution = this.resolveOriginalYearInternal(release).finally(() => {
      this.resolutionRequests.delete(release.id);
    });
    this.resolutionRequests.set(release.id, resolution);
    return resolution;
  }

  async startReleaseDetailEnrichment(): Promise<void> {
    if (this.releaseDetailQueueRunning) return;
    this.releaseDetailQueueRunning = true;

    try {
      const allReleases = (await this.db.getAllReleases()) ?? [];
      const pending = allReleases.filter((release) => release.basicInfo.detailsFetched !== true);
      const uniquePending = [...new Map(pending.map((release) => [release.id, release])).values()];
      this.releaseDetailProgressSignal.set({
        total: uniquePending.length,
        completed: 0,
        inProgress: uniquePending.length > 0,
      });

      for (const release of uniquePending) {
        try {
          const enriched = await this.ensureReleaseMetadata(release);
          if (enriched) {
            this.releaseDetailUpdated.next(release.id);
            this.releaseDetailProgressSignal.update((progress) => ({
              ...progress,
              completed: progress.completed + 1,
            }));
          }
        } catch (error) {
          console.error(`Failed to enrich release ${release.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Release detail enrichment failed:', error);
    } finally {
      this.releaseDetailQueueRunning = false;
      this.releaseDetailProgressSignal.update((progress) => ({ ...progress, inProgress: false }));
    }
  }

  async ensureReleaseMetadata(release: Release): Promise<boolean> {
    if (release.basicInfo.detailsFetched === true) return true;
    if (this.completedReleaseMetadata.has(release.id)) return true;

    const existingRequest = this.releaseMetadataRequests.get(release.id);
    if (existingRequest) return existingRequest;

    const request = this.fetchAndPersistReleaseMetadata(release)
      .then((enriched) => {
        if (enriched) this.completedReleaseMetadata.add(release.id);
        return enriched;
      })
      .finally(() => this.releaseMetadataRequests.delete(release.id));
    this.releaseMetadataRequests.set(release.id, request);
    return request;
  }

  private async resolveOriginalYearInternal(release: Release): Promise<OriginalYearResolution> {
    try {
      const albumCacheKey = this.albumYearCacheKey(release);
      const cachedAlbumYear = await this.db.getMetadata(albumCacheKey);
      if (cachedAlbumYear?.startsWith('none:conclusive')) return 'unknown';
      if (cachedAlbumYear?.startsWith('none:')) {
        const notFoundAt = Number(cachedAlbumYear.slice('none:'.length));
        if (
          Number.isFinite(notFoundAt) &&
          Date.now() - notFoundAt < MUSICBRAINZ_NOT_FOUND_COOLDOWN_MS
        ) {
          return 'unknown';
        }
      }

      const sharedAlbumRequest = this.albumYearRequests.get(albumCacheKey);
      if (sharedAlbumRequest) {
        const sourceResult = await sharedAlbumRequest;
        if (sourceResult.year != null) {
          await this.persistOriginalYear(release, sourceResult.year, release.basicInfo.masterId);
          return 'known';
        }
        return 'unknown';
      }

      const resolutionRequest = this.resolveOriginalYearFromSources(release, albumCacheKey);
      this.albumYearRequests.set(albumCacheKey, resolutionRequest);
      const sourceResult = await resolutionRequest;
      this.albumYearRequests.delete(albumCacheKey);
      if (sourceResult.year == null) {
        if (!sourceResult.retryable) {
          await this.db.setMetadata(albumCacheKey, 'none:conclusive');
        }
        return 'unknown';
      }
      const year = sourceResult.year;
      await this.db.setMetadata(albumCacheKey, String(year));
      await this.persistOriginalYear(release, year, release.basicInfo.masterId);
      return 'known';
    } catch (error) {
      console.error(`Failed to resolve original year for release ${release.id}:`, error);
      return 'unknown';
    }
  }

  private async resolveOriginalYearFromSources(
    release: Release,
    albumCacheKey: string,
  ): Promise<OriginalYearSourceResult> {
    let masterId = release.basicInfo.masterId;
    let releaseDetails: DiscogsReleaseDetails | null = null;
    let masterLookupConclusive = false;

    if (!masterId) {
      const cachedMasterId = await this.db.getMetadata(this.releaseMasterCacheKey(release.id));
      if (cachedMasterId === 'none:conclusive') {
        masterLookupConclusive = true;
      } else if (cachedMasterId === 'none') {
        masterId = undefined;
      }
      if (masterId == null && cachedMasterId && cachedMasterId !== 'none') {
        masterId = Number(cachedMasterId);
      }
    }

    if (!masterId && !masterLookupConclusive) {
      releaseDetails = await this.fetchReleaseDetails(release.id);
      if (!releaseDetails) return { retryable: true };
      masterId = releaseDetails?.master_id;
      await this.db.setMetadata(
        this.releaseMasterCacheKey(release.id),
        masterId ? String(masterId) : 'none:conclusive',
      );

      if (masterId) {
        await this.updateReleaseDetails(release, releaseDetails, masterId);
      }
    }

    let year: number | undefined;
    let discogsRetryable = false;
    if (masterId) {
      const cachedYear = await this.db.getMetadata(this.masterYearCacheKey(masterId));
      year =
        cachedYear && !cachedYear.startsWith('none:') && cachedYear !== 'none'
          ? Number(cachedYear)
          : undefined;
      if (cachedYear === 'none:conclusive') return { retryable: false };
      if (!Number.isFinite(year)) {
        let request = this.masterYearRequests.get(masterId);
        if (!request) {
          request = this.fetchMasterRelease(masterId).then((master) => master?.year);
          this.masterYearRequests.set(masterId, request);
          void request.then(
            () => this.masterYearRequests.delete(masterId),
            () => this.masterYearRequests.delete(masterId),
          );
        }
        try {
          year = await request;
        } catch (error) {
          console.error(`Failed to resolve Discogs master ${masterId}:`, error);
          discogsRetryable = true;
        }
        if (year != null)
          await this.db.setMetadata(this.masterYearCacheKey(masterId), String(year));
      }

      if (!Number.isFinite(year)) {
        try {
          year = await this.fetchEarliestMasterReleaseYear(masterId);
        } catch (error) {
          console.error(`Failed to resolve Discogs master versions ${masterId}:`, error);
          discogsRetryable = true;
        }
        if (!discogsRetryable) {
          await this.db.setMetadata(
            this.masterYearCacheKey(masterId),
            year != null ? String(year) : 'none:conclusive',
          );
        }
      }
    }

    if (year == null || !Number.isFinite(year)) {
      const musicBrainzResult = await this.fetchMusicBrainzYear(release, albumCacheKey);
      return {
        ...musicBrainzResult,
        retryable: discogsRetryable || musicBrainzResult.retryable,
      };
    }
    return { year, retryable: false };
  }

  private async persistOriginalYear(
    release: Release,
    year: number,
    masterId?: number,
  ): Promise<void> {
    const current = await this.db.getRelease(release.id);
    const basicInfo = current?.basicInfo ?? release.basicInfo;
    await this.db.updateRelease(release.id, {
      basicInfo: { ...basicInfo, ...(masterId ? { masterId } : {}), originalYear: year },
    });
    await this.persistEnrichment(release.id);
  }

  private async updateReleaseDetails(
    release: Release,
    details: DiscogsReleaseDetails | null,
    masterId?: number,
  ): Promise<void> {
    if (!details) return;
    const basicInfo = { ...release.basicInfo, ...(masterId ? { masterId } : {}) };
    const label = details.labels?.[0]?.name;
    const catalogNumber = details.labels?.[0]?.catno;
    const format = details.formats
      ?.map((item) => conciseDiscogsFormat(item.name, item.descriptions, item.qty))
      .filter(Boolean)
      .join(', ');
    const tracklist: ReleaseTrack[] | undefined = details.tracklist?.map((track) => ({
      position: track.position ?? '',
      title: track.title ?? '',
      ...(track.duration ? { duration: track.duration } : {}),
      ...(track.type ? { type: track.type } : {}),
    }));
    const musicalTracks =
      tracklist?.filter((track) => track.type !== 'heading' && track.type !== 'index') ?? [];
    const durations = musicalTracks.map((track) => this.durationToSeconds(track.duration));
    Object.assign(basicInfo, {
      ...(label ? { label } : {}),
      ...(catalogNumber ? { catalogNumber } : {}),
      ...(format ? { format } : {}),
      ...(details.year != null ? { year: details.year } : {}),
      detailsFetched: true,
      trackCount: musicalTracks.length,
      tracklist: tracklist ?? [],
      ...(musicalTracks.length > 0 &&
      durations.every((duration): duration is number => duration != null)
        ? { totalRuntimeSeconds: durations.reduce((sum, value) => sum + value, 0) }
        : {}),
    });
    await this.db.updateRelease(release.id, { basicInfo });
    await this.persistEnrichment(release.id);
  }

  private async fetchAndPersistReleaseMetadata(release: Release): Promise<boolean> {
    const details = await this.fetchReleaseDetails(release.id);
    if (!details) return false;
    await this.updateReleaseDetails(
      release,
      details,
      details.master_id ?? release.basicInfo.masterId,
    );
    return true;
  }

  private async persistEnrichment(releaseId: number): Promise<void> {
    if (!this.catalogService) return;
    try {
      const release = await this.db.getRelease(releaseId);
      if (release) {
        const {
          masterId,
          originalYear,
          year,
          label,
          catalogNumber,
          format,
          tracklist,
          detailsFetched,
          trackCount,
          totalRuntimeSeconds,
        } = release.basicInfo;
        const enrichment: ReleaseEnrichment = {
          ...(masterId !== undefined ? { masterId } : {}),
          ...(originalYear !== undefined ? { originalYear } : {}),
          ...(year !== undefined ? { year } : {}),
          ...(label !== undefined ? { label } : {}),
          ...(catalogNumber !== undefined ? { catalogNumber } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(tracklist !== undefined ? { tracklist } : {}),
          ...(detailsFetched !== undefined ? { detailsFetched } : {}),
          ...(trackCount !== undefined ? { trackCount } : {}),
          ...(totalRuntimeSeconds !== undefined ? { totalRuntimeSeconds } : {}),
        };
        await this.catalogService.writeEnrichment(releaseId, enrichment);
      }
    } catch (error) {
      console.error('Failed to persist enriched catalog:', error);
    }
  }

  private async fetchEarliestMasterReleaseYear(masterId: number): Promise<number | undefined> {
    const url = this.discogsUrl(`/masters/${masterId}/versions`);
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
    });
    try {
      const response = await this.requestScheduler.request<DiscogsMasterVersionsResponse>(url, {
        headers,
      });
      await this.delay(DISCOGS_API_DELAY_MS);
      const years = (response.body?.versions ?? [])
        .map((version) => this.parseYear(version.released))
        .filter((year): year is number => year != null);
      return years.length ? Math.min(...years) : undefined;
    } catch (error) {
      console.error(`Failed to fetch versions for master ${masterId}:`, error);
      throw error;
    }
  }

  /**
   * Fetch master release data for all releases that need it
   */
  private async fetchMasterReleasesInBackground(): Promise<void> {
    this.abortController = new AbortController();

    try {
      const releasesNeedingData = await this.db.getReleasesNeedingMasterData();
      const completedCount = await this.db.getReleasesWithOriginalYearCount();

      if (releasesNeedingData.length === 0) {
        console.log('All releases already have master data');
        return;
      }

      this.progressSignal.set({
        total: releasesNeedingData.length + completedCount,
        completed: completedCount,
        inProgress: true,
      });

      console.log(`Starting master fetch: ${releasesNeedingData.length} releases to process`);

      for (const release of releasesNeedingData) {
        if (this.abortController.signal.aborted) {
          console.log('Master fetch aborted');
          break;
        }

        if (!release.basicInfo.masterId) {
          continue;
        }

        try {
          const masterData = await this.fetchMasterRelease(release.basicInfo.masterId);

          if (masterData?.year != null) {
            await this.db.updateRelease(release.id, {
              basicInfo: {
                ...release.basicInfo,
                originalYear: masterData.year,
              },
            });

            // Only increment after successful database update
            this.progressSignal.update((p) => ({
              ...p,
              completed: p.completed + 1,
            }));
          }
        } catch (error) {
          console.error(`Failed to fetch master for release ${release.id}:`, error);
        }

        // Rate limiting delay
        await this.delay(DISCOGS_API_DELAY_MS);
      }

      console.log('Master fetch completed');
    } catch (error) {
      console.error('Master fetch failed:', error);
    } finally {
      this.progressSignal.update((p) => ({ ...p, inProgress: false }));
      this.abortController = null;
    }
  }

  /**
   * Fetch a single master release from Discogs API with retry logic
   */
  private async fetchMasterRelease(
    masterId: number,
    maxRetries = 3,
  ): Promise<DiscogsMasterRelease | null> {
    const existingRequest = this.masterRequests.get(masterId);
    if (existingRequest) return existingRequest;

    const request = this.fetchMasterReleaseWithRetry(masterId, maxRetries);
    this.masterRequests.set(masterId, request);
    void request.catch(() => this.masterRequests.delete(masterId));
    return request;
  }

  private async fetchMasterReleaseWithRetry(
    masterId: number,
    maxRetries: number,
  ): Promise<DiscogsMasterRelease | null> {
    const url = this.discogsUrl(`/masters/${masterId}`);
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.requestScheduler.request<DiscogsMasterRelease>(url, {
          headers,
          label: `master ${masterId}`,
        });
        await this.delay(DISCOGS_API_DELAY_MS);
        return response.body as DiscogsMasterRelease;
      } catch (error) {
        if (attempt === maxRetries) {
          console.error(`Failed to fetch master ${masterId} after ${maxRetries} attempts:`, error);
          throw error;
        }
        // Wait before retrying (exponential backoff: 2s, 4s, 8s...)
        const retryDelay = DISCOGS_API_DELAY_MS * Math.pow(2, attempt);
        console.warn(`Retry ${attempt}/${maxRetries} for master ${masterId} in ${retryDelay}ms`);
        await this.delay(retryDelay);
      }
    }

    return null;
  }

  private async fetchReleaseDetails(releaseId: number): Promise<DiscogsReleaseDetails | null> {
    const url = this.discogsUrl(`/releases/${releaseId}`);
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
    });

    try {
      const response = await this.requestScheduler.request<DiscogsReleaseDetails>(url, { headers });
      await this.delay(DISCOGS_API_DELAY_MS);
      return response.body as DiscogsReleaseDetails;
    } catch (error) {
      console.error(`Failed to fetch release details for ${releaseId}:`, error);
      return null;
    }
  }

  private async fetchMusicBrainzYear(
    release: Release,
    albumCacheKey: string,
  ): Promise<OriginalYearSourceResult> {
    const cached = await this.db.getMetadata(`musicBrainz:${albumCacheKey}`);
    if (cached === 'none') return { retryable: false };
    if (cached) return { year: this.parseYear(cached), retryable: false };

    const artists = release.basicInfo.artists
      .map((artist) => this.normalizeMatchText(artist))
      .join(' ');
    const title = this.normalizeMatchText(release.basicInfo.title);
    const query = `artist:"${artists}" AND releasegroup:"${title}"`;
    const url = `${this.musicBrainzApiUrl}?path=/release-group/`;
    const headers = new HttpHeaders({
      Accept: 'application/json',
    });

    try {
      const response = await this.musicBrainzScheduler.request<MusicBrainzSearchResponse>(
        `originalYear:${albumCacheKey}`,
        url,
        { headers, params: { query, fmt: 'json', limit: '20' } },
      );
      await this.delay(DISCOGS_API_DELAY_MS);
      const match = (response.body?.['release-groups'] ?? [])
        .filter((group) => this.musicBrainzMatches(group, release))
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
      const year = this.parseYear(match?.['first-release-date']);
      if (year != null) {
        await this.db.setMetadata(`musicBrainz:${albumCacheKey}`, String(year));
        return { year, retryable: false };
      }
      await this.db.setMetadata(`musicBrainz:${albumCacheKey}`, `none:${Date.now()}`);
      return { retryable: false };
    } catch (error) {
      console.error(`Failed to fetch MusicBrainz data for ${release.basicInfo.title}:`, error);
      return { retryable: true };
    }
  }

  private musicBrainzMatches(group: MusicBrainzReleaseGroup, release: Release): boolean {
    const titleMatches =
      this.normalizeMatchText(group.title) === this.normalizeMatchText(release.basicInfo.title);
    const artists = (group['artist-credit'] ?? []).map(
      (credit) => credit.name ?? credit.artist?.name ?? '',
    );
    const artistMatches = release.basicInfo.artists.some((artist) =>
      artists.some(
        (candidate) => this.normalizeMatchText(candidate) === this.normalizeMatchText(artist),
      ),
    );
    return titleMatches && artistMatches;
  }

  private normalizeMatchText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+\(\d+\)$/g, '')
      .trim()
      .toLocaleLowerCase()
      .replace(/^(the|an|a)\s+/, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private parseYear(value?: string | number): number | undefined {
    const match = String(value ?? '').match(/\b(18|19|20)\d{2}\b/);
    if (!match) return undefined;
    const year = Number(match[0]);
    return year >= 1800 && year <= new Date().getFullYear() ? year : undefined;
  }

  private durationToSeconds(duration?: string): number | undefined {
    if (!duration) return undefined;
    const parts = duration.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return undefined;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return undefined;
  }

  private releaseMasterCacheKey(releaseId: number): string {
    return `releaseMasterId:${releaseId}`;
  }

  private masterYearCacheKey(masterId: number): string {
    return `masterOriginalYear:${masterId}`;
  }

  private albumYearCacheKey(release: Release): string {
    const artist = release.basicInfo.artists
      .map((value) => this.normalizeMatchText(value))
      .sort()
      .join('|');
    return `originalYear:${artist}:${this.normalizeMatchText(release.basicInfo.title)}`;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private discogsUrl(path: string): string {
    return `${this.apiUrl}?path=${path}`;
  }
}
