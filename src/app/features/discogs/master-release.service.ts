import { Injectable, signal, computed } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom, Subject } from 'rxjs';
import { environment } from '../../../environments/environment';
import { DatabaseService } from '../../core/database.service';
import { CredentialsService } from '../../core/credentials.service';
import { Release, ReleaseTrack } from '../../shared/models/release.model';
import {
  DiscogsMasterRelease,
  DiscogsMasterVersionsResponse,
  DiscogsReleaseDetails,
  conciseDiscogsFormat,
} from './discogs-api.model';
import { DISCOGS_API_DELAY_MS } from '../../shared/constants/timing.constants';

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

@Injectable({
  providedIn: 'root',
})
export class MasterReleaseService {
  private apiUrl = environment.discogsApiUrl;
  private musicBrainzApiUrl = environment.musicBrainzApiUrl;
  private abortController: AbortController | null = null;
  private readonly resolutionRequests = new Map<number, Promise<OriginalYearResolution>>();
  private readonly masterYearRequests = new Map<number, Promise<number | undefined>>();
  private readonly albumYearRequests = new Map<string, Promise<number | undefined>>();
  private readonly releaseMetadataRequests = new Map<number, Promise<boolean>>();
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
    private http: HttpClient,
    private db: DatabaseService,
    private credentialsService: CredentialsService,
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
      const allReleases = await this.db.getAllReleases();
      const pending = allReleases.filter((release) => release.basicInfo.detailsFetched !== true);
      const uniquePending = [...new Map(pending.map((release) => [release.id, release])).values()];
      this.releaseDetailProgressSignal.set({
        total: allReleases.length,
        completed: allReleases.length - uniquePending.length,
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

    const existingRequest = this.releaseMetadataRequests.get(release.id);
    if (existingRequest) return existingRequest;

    const request = this.fetchAndPersistReleaseMetadata(release).finally(() => {
      this.releaseMetadataRequests.delete(release.id);
    });
    this.releaseMetadataRequests.set(release.id, request);
    return request;
  }

  private async resolveOriginalYearInternal(release: Release): Promise<OriginalYearResolution> {
    try {
      const albumCacheKey = this.albumYearCacheKey(release);
      const cachedAlbumYear = await this.db.getMetadata(albumCacheKey);
      if (cachedAlbumYear === 'none') return 'unknown';
      if (cachedAlbumYear) {
        const year = Number(cachedAlbumYear);
        if (Number.isFinite(year)) {
          await this.persistOriginalYear(release, year, release.basicInfo.masterId);
          return 'known';
        }
      }

      const sharedAlbumRequest = this.albumYearRequests.get(albumCacheKey);
      if (sharedAlbumRequest) {
        const year = await sharedAlbumRequest;
        if (year != null) await this.persistOriginalYear(release, year, release.basicInfo.masterId);
        return year != null ? 'known' : 'unknown';
      }

      const resolutionRequest = this.resolveOriginalYearFromSources(release, albumCacheKey);
      this.albumYearRequests.set(albumCacheKey, resolutionRequest);
      const year = await resolutionRequest;
      this.albumYearRequests.delete(albumCacheKey);
      if (year == null) {
        await this.db.setMetadata(albumCacheKey, 'none');
        return 'unknown';
      }
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
  ): Promise<number | undefined> {
    let masterId = release.basicInfo.masterId;
    let releaseDetails: DiscogsReleaseDetails | null = null;

    if (!masterId) {
      const cachedMasterId = await this.db.getMetadata(this.releaseMasterCacheKey(release.id));
      if (cachedMasterId === 'none') {
        releaseDetails = null;
      }
      masterId = cachedMasterId ? Number(cachedMasterId) : undefined;
    }

    if (!masterId) {
      releaseDetails = await this.fetchReleaseDetails(release.id);
      masterId = releaseDetails?.master_id;
      await this.db.setMetadata(
        this.releaseMasterCacheKey(release.id),
        masterId ? String(masterId) : 'none',
      );

      if (masterId) {
        await this.updateReleaseDetails(release, releaseDetails, masterId);
      }
    }

    let year: number | undefined;
    if (masterId) {
      const cachedYear = await this.db.getMetadata(this.masterYearCacheKey(masterId));
      year = cachedYear && cachedYear !== 'none' ? Number(cachedYear) : undefined;
      if (cachedYear !== 'none' && !Number.isFinite(year)) {
        let request = this.masterYearRequests.get(masterId);
        if (!request) {
          request = this.fetchMasterRelease(masterId).then((master) => master?.year);
          this.masterYearRequests.set(masterId, request);
          void request.then(
            () => this.masterYearRequests.delete(masterId),
            () => this.masterYearRequests.delete(masterId),
          );
        }
        year = await request;
        if (year != null)
          await this.db.setMetadata(this.masterYearCacheKey(masterId), String(year));
      }

      if (cachedYear !== 'none' && !Number.isFinite(year)) {
        year = await this.fetchEarliestMasterReleaseYear(masterId);
        await this.db.setMetadata(
          this.masterYearCacheKey(masterId),
          year != null ? String(year) : 'none',
        );
      }
    }

    if (year == null || !Number.isFinite(year)) {
      year = await this.fetchMusicBrainzYear(release, albumCacheKey);
    }
    return year;
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

  private async fetchEarliestMasterReleaseYear(masterId: number): Promise<number | undefined> {
    const url = `${this.apiUrl}/masters/${masterId}/versions`;
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
      'User-Agent': 'VinylTracker/1.0',
    });
    try {
      const response = await firstValueFrom(
        this.http.get<DiscogsMasterVersionsResponse>(url, { headers }),
      );
      await this.delay(DISCOGS_API_DELAY_MS);
      const years = (response.versions ?? [])
        .map((version) => this.parseYear(version.released))
        .filter((year): year is number => year != null);
      return years.length ? Math.min(...years) : undefined;
    } catch (error) {
      console.error(`Failed to fetch versions for master ${masterId}:`, error);
      return undefined;
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
    const url = `${this.apiUrl}/masters/${masterId}`;
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
      'User-Agent': 'VinylTracker/1.0',
    });

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await firstValueFrom(
          this.http.get<DiscogsMasterRelease>(url, { headers }),
        );
        await this.delay(DISCOGS_API_DELAY_MS);
        return response;
      } catch (error) {
        if (attempt === maxRetries) {
          console.error(`Failed to fetch master ${masterId} after ${maxRetries} attempts:`, error);
          return null;
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
    const url = `${this.apiUrl}/releases/${releaseId}`;
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
      'User-Agent': 'VinylTracker/1.0',
    });

    try {
      const response = await firstValueFrom(this.http.get<DiscogsReleaseDetails>(url, { headers }));
      await this.delay(DISCOGS_API_DELAY_MS);
      return response;
    } catch (error) {
      console.error(`Failed to fetch release details for ${releaseId}:`, error);
      return null;
    }
  }

  private async fetchMusicBrainzYear(
    release: Release,
    albumCacheKey: string,
  ): Promise<number | undefined> {
    const cached = await this.db.getMetadata(`musicBrainz:${albumCacheKey}`);
    if (cached === 'none') return undefined;
    if (cached) return this.parseYear(cached);

    const artists = release.basicInfo.artists
      .map((artist) => this.normalizeMatchText(artist))
      .join(' ');
    const title = this.normalizeMatchText(release.basicInfo.title);
    const query = `artist:"${artists}" AND releasegroup:"${title}"`;
    const url = `${this.musicBrainzApiUrl}/release-group/`;
    const headers = new HttpHeaders({
      Accept: 'application/json',
      'User-Agent': 'VinylTracker/1.0 (vinyl-tracker@example.invalid)',
    });

    try {
      const response = await firstValueFrom(
        this.http.get<MusicBrainzSearchResponse>(url, {
          headers,
          params: { query, fmt: 'json', limit: '20' },
        }),
      );
      await this.delay(DISCOGS_API_DELAY_MS);
      const match = (response['release-groups'] ?? [])
        .filter((group) => this.musicBrainzMatches(group, release))
        .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
      const year = this.parseYear(match?.['first-release-date']);
      await this.db.setMetadata(
        `musicBrainz:${albumCacheKey}`,
        year != null ? String(year) : 'none',
      );
      return year;
    } catch (error) {
      console.error(`Failed to fetch MusicBrainz data for ${release.basicInfo.title}:`, error);
      return undefined;
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
}
