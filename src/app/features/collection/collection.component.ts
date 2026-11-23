import { Component, computed, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { DatabaseService } from '../../core/database.service';
import { Release } from '../../shared/models/release.model';
import { MasterReleaseService } from '../discogs/master-release.service';
import { FilterService } from '../../shared/services/filter.service';
import {
  artistCreditKey,
  MissingAlbum,
  MissingAlbumsService,
  pressingLabel,
  pressingSummary,
  VinylPressing,
} from './missing-albums.service';
import { WantlistService } from './wantlist.service';
import { MenuDrawerComponent } from '../../layout/menu-drawer/menu-drawer.component';
import { SearchSheetComponent } from '../player/search-sheet/search-sheet.component';
import { PlayHistorySheetComponent } from '../player/play-history-sheet/play-history-sheet.component';
import { StatsSheetComponent } from '../stats/stats-sheet/stats-sheet.component';
import { AchievementsSheetComponent } from '../achievements/achievements-sheet/achievements-sheet.component';
import { ChangelogSheetComponent } from '../changelog/changelog-sheet/changelog-sheet.component';
import { NavigationControlsComponent } from '../../layout/navigation-controls/navigation-controls.component';
import {
  artistSection,
  COLLECTION_LETTERS,
  CollectionGroup,
  groupCollection,
  sortCollection,
} from './collection.utils';

export { sortCollection } from './collection.utils';

type ResolutionState = 'fetching' | 'unknown';

const PACIFIC_DATE = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'full',
  timeZone: 'America/Los_Angeles',
});
const PACIFIC_TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Los_Angeles',
  timeZoneName: 'short',
});

export function formatPacificDateTime(date: Date): string {
  return `${PACIFIC_DATE.format(date)} · ${PACIFIC_TIME.format(date)}`;
}

// "Various" credits hundreds of thousands of releases, so it has no meaningful discography.
const MISSING_ALBUMS_EXCLUDED_ARTISTS = new Set(['various']);

type LoadState<T> =
  | { status: 'loading'; checked?: number; total?: number }
  | { status: 'ready'; value: T }
  | { status: 'error' };

function albumsKey(group: CollectionGroup): string {
  return artistCreditKey(group.releases[0]?.basicInfo.artists ?? []);
}

function toggled<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return next;
}

function countCopies(releases: Release[]): number {
  return releases.reduce((total, release) => total + (release.copies ?? 1), 0);
}

@Component({
  selector: 'app-collection',
  standalone: true,
  imports: [
    CommonModule,
    NavigationControlsComponent,
    MenuDrawerComponent,
    SearchSheetComponent,
    PlayHistorySheetComponent,
    StatsSheetComponent,
    AchievementsSheetComponent,
    ChangelogSheetComponent,
  ],
  templateUrl: './collection.component.html',
  styleUrls: ['./collection.component.scss'],
})
export class CollectionComponent implements OnInit, OnDestroy {
  @ViewChild(PlayHistorySheetComponent) historySheet?: PlayHistorySheetComponent;

  readonly letters = COLLECTION_LETTERS;
  releases = signal<Release[]>([]);
  currentTime = signal(formatPacificDateTime(new Date()));
  private clockTimer = setInterval(
    () => this.currentTime.set(formatPacificDateTime(new Date())),
    1000,
  );
  isLoading = signal(true);
  resolutionStates = signal<Record<number, ResolutionState>>({});
  expandedReleases = signal<Set<number>>(new Set());
  menuOpen = signal(false);
  searchOpen = signal(false);
  historyOpen = signal(false);
  statsOpen = signal(false);
  achievementsOpen = signal(false);
  changelogOpen = signal(false);

  filteredReleases = computed(() => {
    this.filterService.filters();
    return this.releases().filter((release) => this.filterService.matchesFilters(release));
  });
  onlyMissing = signal(false);
  groups = computed(() => {
    const groups = groupCollection(this.filteredReleases());
    if (!this.onlyMissing()) return groups;
    return groups.filter(
      (group) => this.supportsMissingAlbums(group) && this.missingAlbums(group).length > 0,
    );
  });
  /** Totals across the whole collection, shown once the missing albums summary has loaded. */
  overview = computed(() => {
    if (this.summaryStatus() !== 'ready') return null;
    const artists = groupCollection(this.releases()).filter((group) =>
      this.supportsMissingAlbums(group),
    );
    const missing = artists.reduce((total, group) => total + this.missingAlbums(group).length, 0);
    return { artists: artists.length, missing };
  });
  totalCopies = computed(() => countCopies(this.releases()));
  filteredCopies = computed(() => countCopies(this.filteredReleases()));
  hasActiveFilters = computed(() => this.filterService.hasActiveFilters());
  availableSections = computed(
    () => new Set(this.groups().map((group) => artistSection(group.heading))),
  );
  ownedMasterIds = computed(
    () =>
      new Set(
        this.releases()
          .map((release) => release.basicInfo.masterId)
          .filter((id): id is number => id !== undefined),
      ),
  );
  artistAlbums = signal<Record<string, LoadState<MissingAlbum[]>>>({});
  /** Server-side check progress for artists whose albums aren't saved yet. */
  serverProgress = signal<Record<string, { checked: number; total?: number }>>({});
  summaryStatus = signal<'loading' | 'ready' | 'error'>('loading');
  expandedArtists = signal<Set<string>>(new Set());
  albumPressings = signal<Record<number, LoadState<VinylPressing[]>>>({});
  expandedAlbums = signal<Set<number>>(new Set());
  readonly pressingSummary = pressingSummary;
  readonly pressingLabel = pressingLabel;
  get detailProgress() {
    return (
      this.masterReleaseService.releaseDetailProgress?.() ?? {
        total: 0,
        completed: 0,
        inProgress: false,
      }
    );
  }

  constructor(
    private db: DatabaseService,
    private masterReleaseService: MasterReleaseService,
    private router: Router,
    private filterService: FilterService,
    private missingAlbumsService: MissingAlbumsService,
    readonly wantlist: WantlistService,
  ) {
    this.masterReleaseService.releaseDetailUpdated?.pipe(takeUntil(this.destroy$)).subscribe(() => {
      void this.refreshReleases();
    });
    this.db.collectionChanged?.pipe(takeUntil(this.destroy$)).subscribe(() => {
      void this.refreshReleases();
    });
  }

  private destroy$ = new Subject<void>();

  ngOnDestroy(): void {
    clearInterval(this.clockTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }

  async ngOnInit(): Promise<void> {
    // These filters no longer have controls; clear any value saved before they were removed.
    if (this.filterService.filters().excludeBoxSets) this.filterService.setExcludeBoxSets(false);
    if (this.filterService.filters().notPlayedIn6Months) {
      this.filterService.setNotPlayedIn6Months(false);
    }
    void this.loadMissingAlbumsSummary();
    try {
      const releases = await this.db.getAllReleases();
      this.releases.set(sortCollection(releases));
      this.markUnresolvedReleasesAsFetching(releases);
      void this.masterReleaseService.startReleaseDetailEnrichment();
      void Promise.all(releases.map((release) => this.resolveIfNeeded(release))).catch((error) => {
        console.error('Failed to resolve collection release years:', error);
      });
    } catch (error) {
      console.error('Failed to load collection:', error);
    } finally {
      this.isLoading.set(false);
    }
  }

  originalYear(release: Release): string | number {
    if (release.basicInfo.originalYear != null) return release.basicInfo.originalYear;
    return this.resolutionStates()[release.id] === 'fetching' ? 'Fetching...' : 'Unknown';
  }

  scrollToSection(letter: string): void {
    document.getElementById(`collection-section-${letter}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  sectionKey(heading: string): string {
    return artistSection(heading);
  }

  toggleExpanded(releaseId: number): void {
    this.expandedReleases.update((expanded) => {
      const next = new Set(expanded);
      if (next.has(releaseId)) next.delete(releaseId);
      else next.add(releaseId);
      return next;
    });
  }

  isExpanded(releaseId: number): boolean {
    return this.expandedReleases().has(releaseId);
  }

  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  clearFilters(): void {
    this.filterService.resetFilters();
  }

  supportsMissingAlbums(group: CollectionGroup): boolean {
    return !MISSING_ALBUMS_EXCLUDED_ARTISTS.has(group.key);
  }

  isArtistExpanded(key: string): boolean {
    return this.expandedArtists().has(key);
  }

  missingAlbums(group: CollectionGroup): MissingAlbum[] {
    const state = this.artistAlbums()[albumsKey(group)];
    if (state?.status !== 'ready') return [];
    const owned = this.ownedMasterIds();
    return state.value.filter((album) => !owned.has(album.masterId));
  }

  artistAlbumsState(group: CollectionGroup): LoadState<MissingAlbum[]> | undefined {
    return this.artistAlbums()[albumsKey(group)];
  }

  checkingMessage(group: CollectionGroup): string {
    const progress = this.serverProgress()[albumsKey(group)];
    const counted = progress?.total
      ? ` (${progress.checked} of ${progress.total} titles so far)`
      : '';
    return `Still being checked on Discogs${counted}. This fills in on its own.`;
  }

  missingSummary(group: CollectionGroup): string {
    const state = this.artistAlbums()[albumsKey(group)];
    if (state?.status === 'ready') {
      const owned = group.releases.length;
      return `${owned} ${owned === 1 ? 'Album' : 'Albums'}, ${this.missingAlbums(group).length} Missing`;
    }
    if (this.summaryStatus() !== 'ready') return 'Missing albums';
    const progress = this.serverProgress()[albumsKey(group)];
    if (progress?.total) return `Checking ${progress.checked} of ${progress.total}`;
    return 'Checking Discogs…';
  }

  toggleArtistMissing(group: CollectionGroup): void {
    this.expandedArtists.update((current) => toggled(current, group.key));
  }

  isAlbumExpanded(masterId: number): boolean {
    return this.expandedAlbums().has(masterId);
  }

  pressingsState(masterId: number): LoadState<VinylPressing[]> | undefined {
    return this.albumPressings()[masterId];
  }

  readyPressings(masterId: number): VinylPressing[] {
    const state = this.albumPressings()[masterId];
    return state?.status === 'ready' ? state.value : [];
  }

  toggleOnlyMissing(): void {
    this.onlyMissing.update((value) => !value);
  }

  toggleAlbum(masterId: number): void {
    this.expandedAlbums.update((current) => toggled(current, masterId));
    if (this.isAlbumExpanded(masterId)) void this.wantlist.load();
    const state = this.albumPressings()[masterId];
    if (this.isAlbumExpanded(masterId) && (!state || state.status === 'error')) {
      void this.loadPressings(masterId);
    }
  }

  reloadSummary(): void {
    void this.loadMissingAlbumsSummary();
  }

  retryPressings(masterId: number): void {
    void this.loadPressings(masterId);
  }

  private async loadMissingAlbumsSummary(): Promise<void> {
    this.summaryStatus.set('loading');
    try {
      const summary = await this.missingAlbumsService.loadSummary();
      this.artistAlbums.update((current) => {
        const next = { ...current };
        for (const [key, entry] of Object.entries(summary.artists)) {
          if (entry.albums && next[key]?.status !== 'ready') {
            next[key] = { status: 'ready', value: entry.albums };
          }
        }
        return next;
      });
      const progress: Record<string, { checked: number; total?: number }> = {};
      for (const [key, entry] of Object.entries(summary.artists)) {
        if (!entry.albums) progress[key] = { checked: entry.checked ?? 0, total: entry.total };
      }
      this.serverProgress.set(progress);
      this.summaryStatus.set('ready');
    } catch (error) {
      console.error('Failed to load missing albums summary:', error);
      this.summaryStatus.set('error');
    }
  }

  private async loadPressings(masterId: number): Promise<void> {
    this.albumPressings.update((current) => ({ ...current, [masterId]: { status: 'loading' } }));
    try {
      const pressings = await this.missingAlbumsService.loadPressings(masterId);
      this.albumPressings.update((current) => ({
        ...current,
        [masterId]: { status: 'ready', value: pressings },
      }));
    } catch (error) {
      console.error('Failed to load vinyl pressings:', error);
      this.albumPressings.update((current) => ({ ...current, [masterId]: { status: 'error' } }));
    }
  }

  private setArtistAlbums(key: string, state: LoadState<MissingAlbum[]>): void {
    this.artistAlbums.update((current) => ({ ...current, [key]: state }));
  }

  toggleSearch(): void {
    this.searchOpen.update((open) => !open);
  }

  closeSearch(): void {
    this.searchOpen.set(false);
  }

  toggleHistory(): void {
    this.historyOpen.update((open) => !open);
    if (this.historyOpen()) this.historySheet?.refreshHistory();
  }

  closeHistory(): void {
    this.historyOpen.set(false);
  }

  toggleStats(): void {
    this.statsOpen.update((open) => !open);
  }

  closeStats(): void {
    this.statsOpen.set(false);
  }

  toggleAchievements(): void {
    this.achievementsOpen.update((open) => !open);
  }

  closeAchievements(): void {
    this.achievementsOpen.set(false);
  }

  openChangelog(): void {
    this.changelogOpen.set(true);
  }

  closeChangelog(): void {
    this.changelogOpen.set(false);
  }

  onDataCleared(): void {
    this.router.navigate(['/sync']);
  }

  onReleaseSelected(): void {
    this.router.navigate(['/player']);
  }

  labelAndCatalog(release: Release): string {
    if (this.isMetadataFetching(release)) return 'Fetching...';
    return (
      [release.basicInfo.label, release.basicInfo.catalogNumber].filter(Boolean).join(' · ') ||
      'Unknown'
    );
  }

  formatLabel(release: Release): string {
    if (this.isMetadataFetching(release)) return 'Fetching...';
    return release.basicInfo.format || 'Unknown';
  }

  runtimeLabel(release: Release): string {
    if (this.isMetadataFetching(release)) return 'Fetching...';
    const seconds = release.basicInfo.totalRuntimeSeconds;
    if (seconds == null) return 'Unknown';
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  trackCountLabel(release: Release): string | number {
    if (this.isMetadataFetching(release)) return 'Fetching...';
    return release.basicInfo.trackCount ?? 'Unknown';
  }

  private isMetadataFetching(release: Release): boolean {
    return release.basicInfo.detailsFetched !== true;
  }

  private markUnresolvedReleasesAsFetching(releases: Release[]): void {
    const states: Record<number, ResolutionState> = {};
    for (const release of releases) {
      if (release.basicInfo.originalYear == null) states[release.id] = 'fetching';
    }
    this.resolutionStates.set(states);
  }

  private async resolveIfNeeded(release: Release): Promise<void> {
    if (release.basicInfo.originalYear != null) return;

    const result = await this.masterReleaseService.resolveOriginalYear(release);
    const updated = await this.db.getRelease(release.id);
    if (updated) {
      this.releases.update((current) =>
        sortCollection(current.map((item) => (item.id === updated.id ? updated : item))),
      );
    }
    this.resolutionStates.update((states) => {
      const next = { ...states };
      delete next[release.id];
      if (result === 'unknown') next[release.id] = 'unknown';
      return next;
    });
  }

  private async refreshReleases(): Promise<void> {
    const releases = await this.db.getAllReleases();
    this.releases.set(sortCollection(releases));
  }
}
