import { Injectable } from '@angular/core';
import { HttpHeaders } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { DatabaseService } from '../../core/database.service';
import { PlayHistoryService } from '../player/play-history.service';
import { CredentialsService } from '../../core/credentials.service';
import { Release } from '../../shared/models/release.model';
import {
  conciseDiscogsFormat,
  DiscogsCollectionResponse,
  DiscogsRelease,
} from './discogs-api.model';
import { DISCOGS_API_DELAY_MS } from '../../shared/constants/timing.constants';
import { DiscogsRequestScheduler } from './discogs-request-scheduler.service';
import { CatalogRelease, CatalogService } from '../../core/catalog.service';
import { Optional } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class DiscogsService {
  private apiUrl = environment.discogsApiUrl;

  constructor(
    private db: DatabaseService,
    private playHistoryService: PlayHistoryService,
    private credentialsService: CredentialsService,
    private requestScheduler: DiscogsRequestScheduler,
    @Optional() private catalogService?: CatalogService,
  ) {}

  private get username(): string {
    return this.credentialsService.getUsername() ?? '';
  }

  private get token(): string {
    return this.credentialsService.getToken() ?? '';
  }

  /**
   * Clear all synced data and credentials (full app reset)
   */
  async clearSyncedData(): Promise<void> {
    await this.db.clearAllData();
    this.playHistoryService.clearHistory();
    this.credentialsService.clearCredentials();
    console.log('All synced data and credentials cleared');
  }

  /**
   * Check if user has any synced data
   */
  async hasSyncedData(): Promise<boolean> {
    const count = await this.db.getCollectionCount();
    return count > 0;
  }

  /**
   * Fetch and sync the entire collection from Discogs
   */
  async syncCollection(): Promise<{ success: boolean; totalSynced: number; error?: string }> {
    if (!this.credentialsService.hasCredentials()) {
      return { success: false, totalSynced: 0, error: 'No credentials configured' };
    }

    try {
      console.log('Starting collection sync...');

      // Get first page to determine total pages
      const firstPage = await this.fetchCollectionPage(1);
      const totalPages = firstPage.pagination.pages;
      const totalItems = firstPage.pagination.items;
      const catalog = await this.catalogService?.load();
      const catalogById = new Map(catalog?.releases.map((release) => [release.id, release]) ?? []);
      const currentIds = new Set<number>();

      console.log(`Found ${totalItems} items across ${totalPages} pages`);

      // Process first page
      await this.processReleases(firstPage.releases, catalogById, currentIds);

      // Fetch remaining pages
      for (let page = 2; page <= totalPages; page++) {
        console.log(`Fetching page ${page} of ${totalPages}...`);
        const pageData = await this.fetchCollectionPage(page);
        await this.processReleases(pageData.releases, catalogById, currentIds);

        // Respect rate limits - Discogs allows 60 requests per minute
        await this.delay(DISCOGS_API_DELAY_MS);
      }

      await this.persistCatalog();

      await this.db.setLastSyncDate(new Date());
      const finalCount = await this.db.getCollectionCount();
      console.log(`✅ Sync complete! ${finalCount} releases in database`);

      return { success: true, totalSynced: finalCount };
    } catch (error) {
      console.error('❌ Sync failed:', error);
      return {
        success: false,
        totalSynced: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Convert Discogs API format to our Release model
   */
  private convertToRelease(discogsRelease: DiscogsRelease): Release {
    const basicInfo = discogsRelease.basic_information;

    return {
      id: basicInfo.id,
      instanceId: discogsRelease.instance_id,
      basicInfo: {
        title: basicInfo.title,
        artists: basicInfo.artists.map((a) => a.name),
        year: basicInfo.year || undefined,
        masterId: basicInfo.master_id || undefined,
        formats: basicInfo.formats.map((f) => {
          const descriptions = f.descriptions ? ` (${f.descriptions.join(', ')})` : '';
          return `${f.name}${descriptions}`;
        }),
        discCount:
          basicInfo.formats.reduce((sum, f) => sum + (parseInt(f.qty, 10) || 0), 0) || undefined,
        format:
          basicInfo.formats
            .map((f) => conciseDiscogsFormat(f.name, f.descriptions, f.qty))
            .join(', ') || undefined,
        thumb: basicInfo.thumb,
        coverImage: basicInfo.cover_image,
        labels: basicInfo.labels.map((l) => l.name),
        label: basicInfo.labels[0]?.name,
        catalogNumber: basicInfo.labels[0]?.catno,
        genres: basicInfo.genres,
        styles: basicInfo.styles,
      },
      playCount: 0,
      lastPlayedDate: undefined,
      dateAdded: new Date(),
      dateAddedToCollection: new Date(discogsRelease.date_added),
      notes: discogsRelease.notes?.[0]?.value,
      rating: discogsRelease.rating > 0 ? discogsRelease.rating : undefined,
    };
  }

  /**
   * Utility function to delay execution (for rate limiting)
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch a single page of collection data from Discogs API
   */
  private async fetchCollectionPage(page: number): Promise<DiscogsCollectionResponse> {
    const url = this.discogsUrl(
      `/users/${encodeURIComponent(this.username)}/collection/folders/0/releases`,
    );
    const headers = new HttpHeaders({
      Authorization: `Discogs token=${this.token}`,
    });

    const params = {
      page: page.toString(),
      per_page: '100', // Max allowed by Discogs
    };

    try {
      const response = await this.requestScheduler.request<DiscogsCollectionResponse>(url, {
        headers,
        params,
      });
      return response.body as DiscogsCollectionResponse;
    } catch (error) {
      console.error(`Failed to fetch page ${page}:`, error);
      throw error;
    }
  }

  private discogsUrl(path: string): string {
    return `${this.apiUrl}?path=${path}`;
  }

  /**
   * Convert Discogs API releases to our Release model and store in database
   */
  private async processReleases(
    discogsReleases: DiscogsRelease[],
    catalogById: Map<number, CatalogRelease>,
    currentIds: Set<number>,
  ): Promise<void> {
    for (const discogsRelease of discogsReleases) {
      const release: Release = this.convertToRelease(discogsRelease);
      currentIds.add(release.id);
      const persisted = catalogById.get(release.id);
      if (persisted) {
        release.basicInfo = { ...release.basicInfo, ...persisted.basicInfo };
      }

      // Check if release already exists
      const existing = await this.db.getRelease(release.id);

      if (existing) {
        // Update only the Discogs metadata, preserve play tracking data
        await this.db.updateRelease(release.id, {
          basicInfo: { ...existing.basicInfo, ...release.basicInfo },
          dateAddedToCollection: release.dateAddedToCollection,
          notes: release.notes,
          rating: release.rating,
        });
      } else {
        // New release, add with default tracking values
        await this.db.addRelease(release);
      }
    }
  }

  private async persistCatalog(): Promise<void> {
    if (!this.catalogService) return;
    try {
      await this.catalogService.write();
    } catch (error) {
      console.error('Failed to persist server catalog:', error);
    }
  }
}
