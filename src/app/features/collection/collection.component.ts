import { Component, computed, OnDestroy, OnInit, signal, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subject, takeUntil } from 'rxjs';
import { DatabaseService } from '../../core/database.service';
import { Release } from '../../shared/models/release.model';
import { MasterReleaseService } from '../discogs/master-release.service';
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
  groupCollection,
  sortCollection,
} from './collection.utils';

export { sortCollection } from './collection.utils';

type ResolutionState = 'fetching' | 'unknown';

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
  isLoading = signal(true);
  resolutionStates = signal<Record<number, ResolutionState>>({});
  expandedReleases = signal<Set<number>>(new Set());
  menuOpen = signal(false);
  searchOpen = signal(false);
  historyOpen = signal(false);
  statsOpen = signal(false);
  achievementsOpen = signal(false);
  changelogOpen = signal(false);

  groups = computed(() => groupCollection(this.releases()));
  availableSections = computed(
    () => new Set(this.groups().map((group) => artistSection(group.heading))),
  );
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
  ) {
    this.masterReleaseService.releaseDetailUpdated?.pipe(takeUntil(this.destroy$)).subscribe(() => {
      void this.refreshReleases();
    });
  }

  private destroy$ = new Subject<void>();

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async ngOnInit(): Promise<void> {
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
