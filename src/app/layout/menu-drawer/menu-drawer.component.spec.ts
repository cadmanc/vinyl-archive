import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { signal } from '@angular/core';
import { MenuDrawerComponent } from './menu-drawer.component';
import { DatabaseService } from '../../core/database.service';
import { DiscogsService } from '../../features/discogs/discogs.service';
import { FilterService } from '../../shared/services/filter.service';
import { CredentialsService } from '../../core/credentials.service';
import { MasterReleaseService } from '../../features/discogs/master-release.service';
import { DEFAULT_FILTERS } from '../../shared/models/filter.model';

describe('MenuDrawerComponent', () => {
  let spectator: Spectator<MenuDrawerComponent>;
  let mockDatabaseService: {
    getLastSyncDate: jest.Mock;
    setLastSyncDate: jest.Mock;
    getAllReleases: jest.Mock;
    getRelease: jest.Mock;
    updateRelease: jest.Mock;
    isMasterReleaseSyncEnabled: jest.Mock;
    setMasterReleaseSyncEnabled: jest.Mock;
  };
  let mockDiscogsService: {
    syncCollection: jest.Mock;
    clearSyncedData: jest.Mock;
  };
  let mockFilterService: {
    filters: ReturnType<typeof signal>;
    setExcludeBoxSets: jest.Mock;
    setNotPlayedIn6Months: jest.Mock;
    toggleGenre: jest.Mock;
    toggleDecade: jest.Mock;
    toggleVinylSize: jest.Mock;
    toggleDiscCount: jest.Mock;
  };
  let mockCredentialsService: {
    getUsername: jest.Mock;
    getToken: jest.Mock;
    setCredentials: jest.Mock;
    hasCredentials: jest.Mock;
  };
  let mockMasterReleaseService: {
    startBackgroundFetch: jest.Mock;
    resumeIfNeeded: jest.Mock;
  };

  const createComponent = createComponentFactory({
    component: MenuDrawerComponent,
    detectChanges: false,
  });

  beforeEach(() => {
    mockDatabaseService = {
      getLastSyncDate: jest.fn().mockResolvedValue(null),
      setLastSyncDate: jest.fn().mockResolvedValue(undefined),
      getAllReleases: jest.fn().mockResolvedValue([]),
      getRelease: jest.fn().mockResolvedValue(null),
      updateRelease: jest.fn().mockResolvedValue(undefined),
      isMasterReleaseSyncEnabled: jest.fn().mockResolvedValue(true),
      setMasterReleaseSyncEnabled: jest.fn().mockResolvedValue(undefined),
    };

    mockDiscogsService = {
      syncCollection: jest.fn().mockResolvedValue({ success: true, totalSynced: 0 }),
      clearSyncedData: jest.fn().mockResolvedValue(undefined),
    };

    mockFilterService = {
      filters: signal({ ...DEFAULT_FILTERS }),
      setExcludeBoxSets: jest.fn(),
      setNotPlayedIn6Months: jest.fn(),
      toggleGenre: jest.fn(),
      toggleDecade: jest.fn(),
      toggleVinylSize: jest.fn(),
      toggleDiscCount: jest.fn(),
    };

    mockCredentialsService = {
      getUsername: jest.fn().mockReturnValue('testuser'),
      getToken: jest.fn().mockReturnValue('testtoken'),
      setCredentials: jest.fn(),
      hasCredentials: jest.fn().mockReturnValue(true),
    };

    mockMasterReleaseService = {
      startBackgroundFetch: jest.fn().mockResolvedValue(undefined),
      resumeIfNeeded: jest.fn().mockResolvedValue(undefined),
    };

    spectator = createComponent({
      props: {
        isOpen: false,
      },
      providers: [
        { provide: DatabaseService, useValue: mockDatabaseService },
        { provide: DiscogsService, useValue: mockDiscogsService },
        { provide: FilterService, useValue: mockFilterService },
        { provide: CredentialsService, useValue: mockCredentialsService },
        { provide: MasterReleaseService, useValue: mockMasterReleaseService },
      ],
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should create', () => {
    expect(spectator.component).toBeTruthy();
  });

  describe('closeDrawer', () => {
    it('should emit close event', () => {
      const closeSpy = jest.fn();
      spectator.component.close.subscribe(closeSpy);

      spectator.component.closeDrawer();

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('onBackdropClick', () => {
    it('should call closeDrawer', () => {
      const closeSpy = jest.fn();
      spectator.component.close.subscribe(closeSpy);

      spectator.component.onBackdropClick();

      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('loadFilterOptions', () => {
    const mockReleasesWithFilters = [
      {
        id: 1,
        instanceId: 1,
        basicInfo: {
          title: 'Album 1',
          artists: ['Artist 1'],
          year: 1985,
          formats: ['Vinyl'],
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Rock', 'Pop'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
        notes: '',
        rating: 0,
      },
      {
        id: 2,
        instanceId: 2,
        basicInfo: {
          title: 'Album 2',
          artists: ['Artist 2'],
          year: 1992,
          formats: ['Vinyl'],
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Jazz', 'Rock'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
        notes: '',
        rating: 0,
      },
      {
        id: 3,
        instanceId: 3,
        basicInfo: {
          title: 'Album 3',
          artists: ['Artist 3'],
          year: 0, // No year
          formats: ['Vinyl'],
          thumb: '',
          coverImage: '',
          labels: [],
          genres: undefined,
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
        notes: '',
        rating: 0,
      },
    ];

    it('should extract unique genres from releases', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithFilters);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const genres = spectator.component.availableGenres();
      expect(genres).toContain('Rock');
      expect(genres).toContain('Pop');
      expect(genres).toContain('Jazz');
      expect(genres.length).toBe(3);
    });

    it('should sort genres alphabetically', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithFilters);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const genres = spectator.component.availableGenres();
      expect(genres).toEqual(['Jazz', 'Pop', 'Rock']);
    });

    it('should extract unique decades from releases', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithFilters);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const decades = spectator.component.availableDecades();
      expect(decades).toContain('1980s');
      expect(decades).toContain('1990s');
      expect(decades.length).toBe(2);
    });

    it('should sort decades chronologically', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithFilters);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const decades = spectator.component.availableDecades();
      expect(decades).toEqual(['1980s', '1990s']);
    });

    it('should skip releases without year for decades', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithFilters);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const decades = spectator.component.availableDecades();
      // Album 3 has year 0, should not create a '0s' decade
      expect(decades).not.toContain('0s');
    });

    it('should handle releases with undefined genres', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithFilters);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      // Should not throw and should still have genres from other releases
      expect(spectator.component.availableGenres().length).toBe(3);
    });

    it('should handle getAllReleases error gracefully', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      mockDatabaseService.getAllReleases.mockRejectedValue(new Error('Database error'));

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      expect(consoleSpy).toHaveBeenCalledWith('Failed to load filter options:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('filter toggle methods', () => {
    it('should toggle genre and emit filtersChanged', () => {
      const filtersChangedSpy = jest.fn();
      spectator.component.filtersChanged.subscribe(filtersChangedSpy);

      spectator.component.toggleGenre('Rock');

      expect(mockFilterService.toggleGenre).toHaveBeenCalledWith('Rock');
      expect(filtersChangedSpy).toHaveBeenCalledTimes(1);
    });

    it('should toggle decade and emit filtersChanged', () => {
      const filtersChangedSpy = jest.fn();
      spectator.component.filtersChanged.subscribe(filtersChangedSpy);

      spectator.component.toggleDecade('1980s');

      expect(mockFilterService.toggleDecade).toHaveBeenCalledWith('1980s');
      expect(filtersChangedSpy).toHaveBeenCalledTimes(1);
    });

    it('should return true for selected genre', () => {
      mockFilterService.filters.set({ ...DEFAULT_FILTERS, genres: ['Rock', 'Jazz'] });

      expect(spectator.component.selectedGenres().has('Rock')).toBe(true);
      expect(spectator.component.selectedGenres().has('Jazz')).toBe(true);
    });

    it('should return false for unselected genre', () => {
      mockFilterService.filters.set({ ...DEFAULT_FILTERS, genres: ['Rock'] });

      expect(spectator.component.selectedGenres().has('Jazz')).toBe(false);
    });

    it('should return true for selected decade', () => {
      mockFilterService.filters.set({ ...DEFAULT_FILTERS, decades: ['1980s', '1990s'] });

      expect(spectator.component.selectedDecades().has('1980s')).toBe(true);
      expect(spectator.component.selectedDecades().has('1990s')).toBe(true);
    });

    it('should return false for unselected decade', () => {
      mockFilterService.filters.set({ ...DEFAULT_FILTERS, decades: ['1980s'] });

      expect(spectator.component.selectedDecades().has('1970s')).toBe(false);
    });
  });

  describe('ngOnDestroy', () => {
    it('should complete destroy$ subject', () => {
      expect(() => spectator.component.ngOnDestroy()).not.toThrow();
    });
  });

  describe('original decade filter', () => {
    const mockReleasesWithOriginalDecades = [
      {
        id: 1,
        instanceId: 1,
        basicInfo: {
          title: 'Album 1',
          artists: ['Artist 1'],
          year: 2020,
          originalYear: 1975,
          formats: ['Vinyl'],
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Rock'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
      },
      {
        id: 2,
        instanceId: 2,
        basicInfo: {
          title: 'Album 2',
          artists: ['Artist 2'],
          year: 2015,
          originalYear: 1985,
          formats: ['Vinyl'],
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Jazz'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
      },
    ];

    it('should extract unique original decades from releases', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithOriginalDecades);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const originalDecades = spectator.component.availableOriginalDecades();
      expect(originalDecades).toContain('1970s');
      expect(originalDecades).toContain('1980s');
      expect(originalDecades.length).toBe(2);
    });

    it('should sort original decades chronologically', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithOriginalDecades);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const originalDecades = spectator.component.availableOriginalDecades();
      expect(originalDecades).toEqual(['1970s', '1980s']);
    });

    it('should skip releases without originalYear', async () => {
      const releasesWithMissingOriginalYear = [
        ...mockReleasesWithOriginalDecades,
        {
          id: 3,
          instanceId: 3,
          basicInfo: {
            title: 'Album 3',
            artists: ['Artist 3'],
            year: 2010,
            originalYear: undefined,
            formats: ['Vinyl'],
            thumb: '',
            coverImage: '',
            labels: [],
            genres: ['Pop'],
            styles: [],
          },
          playCount: 0,
          dateAdded: new Date(),
          dateAddedToCollection: new Date(),
        },
      ];
      mockDatabaseService.getAllReleases.mockResolvedValue(releasesWithMissingOriginalYear);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const originalDecades = spectator.component.availableOriginalDecades();
      expect(originalDecades.length).toBe(2);
    });

    describe('toggleOriginalDecade', () => {
      beforeEach(() => {
        (mockFilterService as any).toggleOriginalDecade = jest.fn();
      });

      it('should toggle original decade and emit filtersChanged', () => {
        const filtersChangedSpy = jest.fn();
        spectator.component.filtersChanged.subscribe(filtersChangedSpy);

        spectator.component.toggleOriginalDecade('1970s');

        expect((mockFilterService as any).toggleOriginalDecade).toHaveBeenCalledWith('1970s');
        expect(filtersChangedSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe('selectedOriginalDecades', () => {
      it('should return true for selected original decade', () => {
        mockFilterService.filters.set({ ...DEFAULT_FILTERS, originalDecades: ['1970s', '1980s'] });

        expect(spectator.component.selectedOriginalDecades().has('1970s')).toBe(true);
        expect(spectator.component.selectedOriginalDecades().has('1980s')).toBe(true);
      });

      it('should return false for unselected original decade', () => {
        mockFilterService.filters.set({ ...DEFAULT_FILTERS, originalDecades: ['1970s'] });

        expect(spectator.component.selectedOriginalDecades().has('1990s')).toBe(false);
      });
    });
  });

  describe('disc count filter', () => {
    const mockReleasesWithDiscCounts = [
      {
        id: 1,
        instanceId: 1,
        basicInfo: {
          title: 'Single LP',
          artists: ['Artist 1'],
          year: 2020,
          formats: ['Vinyl (LP)'],
          discCount: 1,
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Rock'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
      },
      {
        id: 2,
        instanceId: 2,
        basicInfo: {
          title: 'Double LP',
          artists: ['Artist 2'],
          year: 2015,
          formats: ['Vinyl (LP)'],
          discCount: 2,
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Jazz'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
      },
      {
        id: 3,
        instanceId: 3,
        basicInfo: {
          title: 'Pre-sync record',
          artists: ['Artist 3'],
          year: 2010,
          formats: ['Vinyl'],
          discCount: undefined, // not yet synced
          thumb: '',
          coverImage: '',
          labels: [],
          genres: ['Pop'],
          styles: [],
        },
        playCount: 0,
        dateAdded: new Date(),
        dateAddedToCollection: new Date(),
      },
    ];

    it('should extract unique disc counts from releases', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithDiscCounts);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const discCounts = spectator.component.availableDiscCounts();
      expect(discCounts).toContain(1);
      expect(discCounts).toContain(2);
      expect(discCounts.length).toBe(2);
    });

    it('should sort disc counts numerically', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithDiscCounts);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      const discCounts = spectator.component.availableDiscCounts();
      expect(discCounts).toEqual([1, 2]);
    });

    it('should skip releases without discCount', async () => {
      mockDatabaseService.getAllReleases.mockResolvedValue(mockReleasesWithDiscCounts);

      spectator.component.loadFilterOptions();

      await Promise.resolve();
      await Promise.resolve();

      // Album 3 has discCount: undefined, should not appear
      const discCounts = spectator.component.availableDiscCounts();
      expect(discCounts.length).toBe(2);
    });

    describe('toggleDiscCount', () => {
      it('should call filterService.toggleDiscCount and emit filtersChanged', () => {
        const filtersChangedSpy = jest.fn();
        spectator.component.filtersChanged.subscribe(filtersChangedSpy);

        spectator.component.toggleDiscCount(2);

        expect(mockFilterService.toggleDiscCount).toHaveBeenCalledWith(2);
        expect(filtersChangedSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe('selectedDiscCounts', () => {
      it('should return true for selected disc count', () => {
        mockFilterService.filters.set({ ...DEFAULT_FILTERS, discCounts: [1, 2] });

        expect(spectator.component.selectedDiscCounts().has(1)).toBe(true);
        expect(spectator.component.selectedDiscCounts().has(2)).toBe(true);
      });

      it('should return false for unselected disc count', () => {
        mockFilterService.filters.set({ ...DEFAULT_FILTERS, discCounts: [1] });

        expect(spectator.component.selectedDiscCounts().has(3)).toBe(false);
      });
    });
  });
});
