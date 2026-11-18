import { Component, computed, signal, input, output, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subject } from 'rxjs';
import { DatabaseService } from '../../core/database.service';
import { FilterService } from '../../shared/services/filter.service';

@Component({
  selector: 'app-menu-drawer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './menu-drawer.component.html',
  styleUrls: ['./menu-drawer.component.scss'],
})
export class MenuDrawerComponent implements OnDestroy {
  // Filter-related signals
  availableGenres = signal<string[]>([]);
  availableDecades = signal<string[]>([]);
  availableOriginalDecades = signal<string[]>([]);
  availableVinylSizes = signal<string[]>([]);
  availableDiscCounts = signal<number[]>([]);

  isOpen = input.required<boolean>();
  close = output<void>();
  filtersChanged = output<void>();

  selectedGenres = computed(() => new Set(this.filterService.filters().genres));
  selectedDecades = computed(() => new Set(this.filterService.filters().decades));
  selectedOriginalDecades = computed(() => new Set(this.filterService.filters().originalDecades));
  selectedVinylSizes = computed(() => new Set(this.filterService.filters().vinylSizes));
  selectedDiscCounts = computed(() => new Set(this.filterService.filters().discCounts));

  hasGenres = computed(() => this.availableGenres().length > 0);
  hasOriginalDecades = computed(() => this.availableOriginalDecades().length > 0);
  hasDecades = computed(() => this.availableDecades().length > 0);
  hasVinylSizes = computed(() => this.availableVinylSizes().length > 0);
  hasDiscCounts = computed(() => this.availableDiscCounts().length > 0);

  private destroy$ = new Subject<void>();

  constructor(
    private db: DatabaseService,
    public filterService: FilterService,
  ) {
    this.loadFilterOptions();

    // Reload filter options and settings when drawer opens
    effect(() => {
      if (this.isOpen()) {
        this.loadFilterOptions();
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  closeDrawer() {
    this.close.emit();
  }

  loadFilterOptions(): void {
    this.db
      .getAllReleases()
      .then((releases) => {
        // Extract unique genres
        const genreSet = new Set<string>();
        releases.forEach((r) => {
          r.basicInfo.genres?.forEach((g) => genreSet.add(g));
        });
        this.availableGenres.set([...genreSet].sort());

        // Extract unique decades (pressing year)
        const decadeSet = new Set<string>();
        releases.forEach((r) => {
          if (r.basicInfo.year) {
            const decade = Math.floor(r.basicInfo.year / 10) * 10;
            decadeSet.add(`${decade}s`);
          }
        });
        this.availableDecades.set([...decadeSet].sort((a, b) => parseInt(a) - parseInt(b)));

        // Extract unique original decades (from master release)
        const originalDecadeSet = new Set<string>();
        releases.forEach((r) => {
          if (r.basicInfo.originalYear) {
            const decade = Math.floor(r.basicInfo.originalYear / 10) * 10;
            originalDecadeSet.add(`${decade}s`);
          }
        });
        this.availableOriginalDecades.set(
          [...originalDecadeSet].sort((a, b) => parseInt(a) - parseInt(b)),
        );

        // Extract unique vinyl sizes from format strings (e.g. "Vinyl (LP, 12\")" → "12\"")
        const SIZE_REGEX = /\b\d+"/g;
        const sizeSet = new Set<string>();
        releases.forEach((r) => {
          r.basicInfo.formats?.forEach((fmt) => {
            fmt.match(SIZE_REGEX)?.forEach((size) => sizeSet.add(size));
          });
        });
        this.availableVinylSizes.set([...sizeSet].sort((a, b) => parseInt(a) - parseInt(b)));

        // Extract unique disc counts
        const discCountSet = new Set<number>();
        releases.forEach((r) => {
          if (r.basicInfo.discCount !== undefined) {
            discCountSet.add(r.basicInfo.discCount);
          }
        });
        this.availableDiscCounts.set([...discCountSet].sort((a, b) => a - b));
      })
      .catch((error) => {
        console.error('Failed to load filter options:', error);
      });
  }

  toggleGenre(genre: string): void {
    this.filterService.toggleGenre(genre);
    this.filtersChanged.emit();
  }

  toggleDecade(decade: string): void {
    this.filterService.toggleDecade(decade);
    this.filtersChanged.emit();
  }

  isGenreSelected(genre: string): boolean {
    return this.filterService.filters().genres.includes(genre);
  }

  isDecadeSelected(decade: string): boolean {
    return this.filterService.filters().decades.includes(decade);
  }

  toggleOriginalDecade(decade: string): void {
    this.filterService.toggleOriginalDecade(decade);
    this.filtersChanged.emit();
  }

  isOriginalDecadeSelected(decade: string): boolean {
    return this.filterService.filters().originalDecades.includes(decade);
  }

  toggleVinylSize(size: string): void {
    this.filterService.toggleVinylSize(size);
    this.filtersChanged.emit();
  }

  toggleDiscCount(count: number): void {
    this.filterService.toggleDiscCount(count);
    this.filtersChanged.emit();
  }

  onBackdropClick() {
    this.closeDrawer();
  }
}
