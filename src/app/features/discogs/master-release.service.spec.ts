import { createServiceFactory, SpectatorService } from '@ngneat/spectator/jest';
import { HttpClient } from '@angular/common/http';
import { of, throwError, NEVER } from 'rxjs';
import { MasterReleaseService } from './master-release.service';
import { DatabaseService } from '../../core/database.service';
import { CredentialsService } from '../../core/credentials.service';
import { Release } from '../../shared/models/release.model';
import { DISCOGS_API_DELAY_MS } from '../../shared/constants/timing.constants';

describe('MasterReleaseService', () => {
  let spectator: SpectatorService<MasterReleaseService>;
  let mockCredentialsService: {
    getToken: jest.Mock;
  };

  const createService = createServiceFactory({
    service: MasterReleaseService,
    mocks: [HttpClient, DatabaseService],
    providers: [
      {
        provide: CredentialsService,
        useFactory: () => {
          mockCredentialsService = {
            getToken: jest.fn().mockReturnValue('testtoken'),
          };
          return mockCredentialsService;
        },
      },
    ],
  });

  const mockReleaseNeedingData: Release = {
    id: 123,
    instanceId: 456,
    basicInfo: {
      title: 'Test Album',
      artists: ['Test Artist'],
      year: 2020,
      masterId: 1000,
      formats: ['Vinyl'],
      labels: ['Test Label'],
      genres: ['Rock'],
      styles: ['Alternative'],
    },
    playCount: 0,
    dateAdded: new Date('2024-01-01'),
    dateAddedToCollection: new Date('2024-01-01'),
  };

  const mockReleaseWithoutMasterId: Release = {
    ...mockReleaseNeedingData,
    id: 124,
    basicInfo: {
      ...mockReleaseNeedingData.basicInfo,
      masterId: undefined,
    },
  };

  const mockMasterResponse = {
    id: 1000,
    year: 1985,
    title: 'Original Album',
    artists: [{ name: 'Test Artist' }],
    genres: ['Rock'],
    styles: ['Alternative'],
  };

  beforeEach(() => {
    spectator = createService();
    jest.useFakeTimers();

    // Default: master release sync is enabled
    const db = spectator.inject(DatabaseService);
    db.isMasterReleaseSyncEnabled.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should be created', () => {
    expect(spectator.service).toBeTruthy();
  });

  describe('initial state', () => {
    it('should initialize progress with defaults', () => {
      expect(spectator.service.progress()).toEqual({
        total: 0,
        completed: 0,
        inProgress: false,
      });
    });

    it('should initialize isInProgress as false', () => {
      expect(spectator.service.isInProgress()).toBe(false);
    });
  });

  describe('startBackgroundFetch', () => {
    it('deduplicates master requests shared by multiple releases', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const secondRelease = { ...mockReleaseNeedingData, id: 124, instanceId: 457 };
      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData, secondRelease]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 4);

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(db.updateRelease).toHaveBeenCalledTimes(2);
    });

    it('should not start if already in progress', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);

      // Start first fetch
      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      // Try to start again while in progress
      spectator.service.startBackgroundFetch();

      expect(consoleSpy).toHaveBeenCalledWith('Master fetch already in progress');

      consoleSpy.mockRestore();
    });

    it('should log when all releases have master data', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);

      db.getReleasesNeedingMasterData.mockResolvedValue([]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(10);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(consoleSpy).toHaveBeenCalledWith('All releases already have master data');

      consoleSpy.mockRestore();
    });

    it('should set progress when starting fetch', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(5);
      // Use an observable that never emits to check initial progress state
      http.get.mockReturnValue(NEVER);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(spectator.service.progress().total).toBe(6);
      expect(spectator.service.progress().completed).toBe(5);
      expect(spectator.service.progress().inProgress).toBe(true);

      consoleSpy.mockRestore();
    });

    it('should fetch master data and update release', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();

      // Wait for the HTTP request and DB update
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);

      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/discogs?path=/masters/1000'),
        expect.objectContaining({
          headers: expect.anything(),
        }),
      );
      const request = http.get.mock.calls[0][1];
      expect(request.headers.get('Authorization')).toBe('Discogs token=testtoken');
      expect(request.headers.get('User-Agent')).toBeNull();

      expect(db.updateRelease).toHaveBeenCalledWith(123, {
        basicInfo: {
          ...mockReleaseNeedingData.basicInfo,
          originalYear: 1985,
        },
      });

      consoleSpy.mockRestore();
    });

    it('should increment completed count after successful update', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 2);

      expect(spectator.service.progress().completed).toBe(1);

      consoleSpy.mockRestore();
    });

    it('should skip releases without masterId', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseWithoutMasterId]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 2);

      expect(http.get).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle HTTP errors gracefully', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(throwError(() => new Error('Network error')));

      spectator.service.startBackgroundFetch();

      // Wait for all retries (exponential backoff: initial + 2s + 4s + 8s)
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 20);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch master 1000 after 3 attempts:'),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleWarnSpy.mockRestore();
    });

    it('should retry with exponential backoff on failure', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);

      // Fail first 2 attempts, succeed on third
      http.get
        .mockReturnValueOnce(throwError(() => new Error('Timeout')))
        .mockReturnValueOnce(throwError(() => new Error('Timeout')))
        .mockReturnValueOnce(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();

      // Advance through retries
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 15);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Retry 1/3 for master 1000'),
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Retry 2/3 for master 1000'),
      );

      consoleWarnSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should set inProgress to false when complete', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 3);

      expect(spectator.service.progress().inProgress).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should log completion message', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 3);

      expect(consoleSpy).toHaveBeenCalledWith('Master fetch completed');

      consoleSpy.mockRestore();
    });

    it('should handle database error during getReleasesNeedingMasterData', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);

      db.getReleasesNeedingMasterData.mockRejectedValue(new Error('Database error'));

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(consoleErrorSpy).toHaveBeenCalledWith('Master fetch failed:', expect.any(Error));
      expect(spectator.service.progress().inProgress).toBe(false);

      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    });

    it('should not increment counter when masterData is null', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      // All retries fail
      http.get.mockReturnValue(throwError(() => new Error('Network error')));

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 20);

      // Should still be 0 since all fetches failed
      expect(spectator.service.progress().completed).toBe(0);

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('resolveOriginalYear', () => {
    it('resolves a 2015 AC/DC pressing to the master release year 1980', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const acdcPressing = {
        ...mockReleaseNeedingData,
        basicInfo: {
          ...mockReleaseNeedingData.basicInfo,
          title: 'Back in Black',
          artists: ['AC/DC'],
          year: 2015,
        },
      };
      db.getMetadata.mockResolvedValue(undefined);
      http.get.mockReturnValue(
        of({ id: 1000, year: 1980, title: 'Back in Black', resource_url: '' }),
      );
      db.updateRelease.mockResolvedValue(1);

      const resultPromise = spectator.service.resolveOriginalYear(acdcPressing);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);

      await expect(resultPromise).resolves.toBe('known');
      expect(db.updateRelease).toHaveBeenCalledWith(123, {
        basicInfo: { ...acdcPressing.basicInfo, originalYear: 1980 },
      });
      expect(db.setMetadata).toHaveBeenCalledWith('masterOriginalYear:1000', '1980');
    });

    it('uses cached known and unknown master years without an API request', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      db.getMetadata.mockImplementation(async (key: string) =>
        key === 'masterOriginalYear:1000' ? '1980' : undefined,
      );
      await expect(spectator.service.resolveOriginalYear(mockReleaseNeedingData)).resolves.toBe(
        'known',
      );
      expect(http.get).not.toHaveBeenCalled();

      http.get.mockClear();
      db.getMetadata.mockResolvedValue('none');
      await expect(
        spectator.service.resolveOriginalYear({ ...mockReleaseNeedingData, id: 999 }),
      ).resolves.toBe('unknown');
      expect(http.get).not.toHaveBeenCalled();
    });

    it('discovers and caches a missing master id from release details', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const releaseWithoutMaster = { ...mockReleaseWithoutMasterId, id: 124 };
      db.getMetadata.mockResolvedValue(undefined);
      http.get
        .mockReturnValueOnce(of({ id: 124, year: 2015, master_id: 1000 }))
        .mockReturnValueOnce(
          of({ id: 1000, year: 1980, title: 'Back in Black', resource_url: '' }),
        );
      db.updateRelease.mockResolvedValue(1);

      const resultPromise = spectator.service.resolveOriginalYear(releaseWithoutMaster);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 2);

      await expect(resultPromise).resolves.toBe('known');
      expect(http.get).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/releases/124'),
        expect.anything(),
      );
      expect(http.get).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/masters/1000'),
        expect.anything(),
      );
      expect(db.setMetadata).toHaveBeenCalledWith('releaseMasterId:124', '1000');
    });

    it('uses the earliest valid Discogs release year when the master has no year', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      db.getMetadata.mockResolvedValue(undefined);
      http.get
        .mockReturnValueOnce(of({ id: 1000, title: 'Album', resource_url: '' }))
        .mockReturnValueOnce(of({ versions: [{ released: '1990' }, { released: '1989' }] }));
      db.updateRelease.mockResolvedValue(1);

      const resultPromise = spectator.service.resolveOriginalYear(mockReleaseNeedingData);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 2);

      await expect(resultPromise).resolves.toBe('known');
      expect(db.updateRelease).toHaveBeenCalledWith(123, {
        basicInfo: { ...mockReleaseNeedingData.basicInfo, originalYear: 1989 },
      });
    });

    it.each([
      ['AFI', 'Sing the Sorrow', 2003],
      ['Billie Eilish', "Don't Smile at Me", 2017],
      ['De La Soul', '3 Feet High and Rising', 1989],
      ['Dr. Dre', 'The Chronic', 1992],
      ['Frank Ocean', 'Blonde', 2016],
      ['Eagles', 'Hotel California', 1976],
    ])('uses MusicBrainz as the final fallback for %s - %s', async (artist, title, year) => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const release = {
        ...mockReleaseNeedingData,
        basicInfo: { ...mockReleaseNeedingData.basicInfo, artists: [artist], title },
      };
      db.getMetadata.mockResolvedValue(undefined);
      http.get
        .mockReturnValueOnce(of({ id: 1000, title, resource_url: '' }))
        .mockReturnValueOnce(of({ versions: [] }))
        .mockReturnValueOnce(
          of({
            'release-groups': [
              {
                title,
                score: 100,
                'first-release-date': `${year}-01-01`,
                'artist-credit': [{ name: artist }],
              },
            ],
          }),
        );
      db.updateRelease.mockResolvedValue(1);

      const resultPromise = spectator.service.resolveOriginalYear(release);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 3);

      await expect(resultPromise).resolves.toBe('known');
      expect(db.setMetadata).toHaveBeenCalledWith(
        expect.stringContaining('musicBrainz:'),
        String(year),
      );
    });

    it('matches MusicBrainz results after punctuation, article, and Discogs suffix normalization', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const release = {
        ...mockReleaseNeedingData,
        basicInfo: {
          ...mockReleaseNeedingData.basicInfo,
          artists: ['The Beatles (2)'],
          title: 'Abbey Road!',
        },
      };
      db.getMetadata.mockResolvedValue(undefined);
      http.get
        .mockReturnValueOnce(of({ id: 1000, title: 'Abbey Road', resource_url: '' }))
        .mockReturnValueOnce(of({ versions: [] }))
        .mockReturnValueOnce(
          of({
            'release-groups': [
              {
                title: 'Abbey Road',
                'first-release-date': '1969',
                'artist-credit': [{ name: 'Beatles' }],
              },
            ],
          }),
        );
      db.updateRelease.mockResolvedValue(1);

      const resultPromise = spectator.service.resolveOriginalYear(release);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 3);

      await expect(resultPromise).resolves.toBe('known');
    });

    it('persists future Discogs metadata without changing the pressing year', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      db.getMetadata.mockResolvedValue(undefined);
      http.get.mockReturnValueOnce(
        of({
          id: 1000,
          year: 1980,
          title: 'Album',
          resource_url: '',
        }),
      );
      db.updateRelease.mockResolvedValue(1);

      const resultPromise = spectator.service.resolveOriginalYear({
        ...mockReleaseNeedingData,
        basicInfo: { ...mockReleaseNeedingData.basicInfo, year: 2015 },
      });
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);

      await expect(resultPromise).resolves.toBe('known');
      expect(db.updateRelease).toHaveBeenCalledWith(
        123,
        expect.objectContaining({
          basicInfo: expect.objectContaining({ year: 2015, originalYear: 1980 }),
        }),
      );
    });
  });

  describe('ensureReleaseMetadata', () => {
    it('persists track count, complete runtime, label, catalog, and concise format', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      http.get.mockReturnValue(
        of({
          id: 123,
          labels: [{ name: 'Atlantic', catno: 'SD 16018' }],
          formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Reissue'] }],
          tracklist: [
            { position: '', title: 'Side A', type: 'heading' },
            { position: 'A1', title: 'One', duration: '3:05' },
            { position: 'A2', title: 'Two', duration: '4:10' },
          ],
        }),
      );
      db.updateRelease.mockResolvedValue(1);

      const request = spectator.service.ensureReleaseMetadata(mockReleaseNeedingData);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);
      await request;

      expect(db.updateRelease).toHaveBeenCalledWith(123, {
        basicInfo: expect.objectContaining({
          detailsFetched: true,
          trackCount: 2,
          totalRuntimeSeconds: 435,
          label: 'Atlantic',
          catalogNumber: 'SD 16018',
          format: '2×LP, Reissue',
          tracklist: [
            { position: '', title: 'Side A', type: 'heading' },
            { position: 'A1', title: 'One', duration: '3:05' },
            { position: 'A2', title: 'Two', duration: '4:10' },
          ],
        }),
      });
    });

    it('does not estimate runtime when any track duration is missing', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      http.get.mockReturnValue(
        of({
          id: 123,
          tracklist: [
            { position: 'A1', title: 'One', duration: '3:05' },
            { position: 'A2', title: 'Two' },
          ],
        }),
      );
      db.updateRelease.mockResolvedValue(1);

      const request = spectator.service.ensureReleaseMetadata(mockReleaseNeedingData);
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);
      await request;

      expect(db.updateRelease).toHaveBeenCalledWith(123, {
        basicInfo: expect.not.objectContaining({ totalRuntimeSeconds: expect.anything() }),
      });
      expect(db.updateRelease).toHaveBeenCalledWith(123, {
        basicInfo: expect.objectContaining({ trackCount: 2 }),
      });
    });
  });

  describe('startReleaseDetailEnrichment', () => {
    it('backfills existing records, processes them sequentially, and reports progress', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const secondRelease = { ...mockReleaseNeedingData, id: 124, instanceId: 457 };
      db.getAllReleases.mockResolvedValue([mockReleaseNeedingData, secondRelease]);
      http.get.mockReturnValue(of({ tracklist: [{ position: 'A1', title: 'Track' }] }));
      db.updateRelease.mockResolvedValue(1);

      const queue = spectator.service.startReleaseDetailEnrichment();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 2);
      await queue;

      expect(http.get).toHaveBeenCalledTimes(2);
      expect(http.get.mock.calls[0][0]).toContain('/releases/123');
      expect(http.get.mock.calls[1][0]).toContain('/releases/124');
      expect(spectator.service.releaseDetailProgress()).toEqual({
        total: 2,
        completed: 2,
        inProgress: false,
      });
    });

    it('does not fetch duplicate release IDs and skips already enriched records', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const duplicate = { ...mockReleaseNeedingData, instanceId: 999 };
      const enriched = {
        ...mockReleaseNeedingData,
        id: 125,
        basicInfo: { ...mockReleaseNeedingData.basicInfo, tracklist: [], detailsFetched: true },
      };
      db.getAllReleases.mockResolvedValue([mockReleaseNeedingData, duplicate, enriched]);
      http.get.mockReturnValue(of({ tracklist: [] }));
      db.updateRelease.mockResolvedValue(1);

      const queue = spectator.service.startReleaseDetailEnrichment();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);
      await queue;

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(http.get).toHaveBeenCalledWith(
        expect.stringContaining('/releases/123'),
        expect.anything(),
      );
      expect(spectator.service.releaseDetailProgress().total).toBe(3);
      expect(spectator.service.releaseDetailProgress().completed).toBe(3);
    });

    it('does not re-enqueue completed records after a reload', async () => {
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);
      const completedRelease = {
        ...mockReleaseNeedingData,
        basicInfo: { ...mockReleaseNeedingData.basicInfo, detailsFetched: true },
      };
      db.getAllReleases.mockResolvedValue([completedRelease]);

      await spectator.service.startReleaseDetailEnrichment();

      expect(http.get).not.toHaveBeenCalled();
      expect(spectator.service.releaseDetailProgress()).toEqual({
        total: 1,
        completed: 1,
        inProgress: false,
      });
    });

    it('starts the detail queue when the existing background sync entry point runs', async () => {
      const db = spectator.inject(DatabaseService);
      db.getAllReleases.mockResolvedValue([]);
      db.getReleasesNeedingMasterData.mockResolvedValue([]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);

      await spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(db.getAllReleases).toHaveBeenCalled();
    });
  });

  describe('resumeIfNeeded', () => {
    it('should start fetch if pending releases exist', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      await spectator.service.resumeIfNeeded();

      expect(consoleSpy).toHaveBeenCalledWith('Resuming master fetch for 1 releases');

      consoleSpy.mockRestore();
    });

    it('should not start if no pending releases', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);

      db.getReleasesNeedingMasterData.mockResolvedValue([]);

      await spectator.service.resumeIfNeeded();

      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Resuming master fetch'));

      consoleSpy.mockRestore();
    });

    it('should not start if already in progress', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(NEVER); // Never emits

      // Start first fetch
      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      // Clear log spy and try to resume
      consoleSpy.mockClear();
      await spectator.service.resumeIfNeeded();

      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Resuming master fetch'));

      consoleSpy.mockRestore();
    });

    it('should handle error gracefully', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const db = spectator.inject(DatabaseService);

      db.getReleasesNeedingMasterData.mockRejectedValue(new Error('Database error'));

      await spectator.service.resumeIfNeeded();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to check for pending master data:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('stopBackgroundFetch', () => {
    it('should set inProgress to false', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(NEVER); // Never emits

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(spectator.service.progress().inProgress).toBe(true);

      spectator.service.stopBackgroundFetch();

      expect(spectator.service.progress().inProgress).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should abort in-progress fetch and set inProgress to false', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      const releases = [
        mockReleaseNeedingData,
        {
          ...mockReleaseNeedingData,
          id: 125,
          basicInfo: { ...mockReleaseNeedingData.basicInfo, masterId: 1001 },
        },
      ];
      db.getReleasesNeedingMasterData.mockResolvedValue(releases);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      // Use NEVER so HTTP call doesn't complete immediately
      http.get.mockReturnValue(NEVER);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(spectator.service.progress().inProgress).toBe(true);

      // Stop while waiting for HTTP response
      spectator.service.stopBackgroundFetch();

      expect(spectator.service.progress().inProgress).toBe(false);

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('should do nothing if not currently fetching', () => {
      // Should not throw
      expect(() => spectator.service.stopBackgroundFetch()).not.toThrow();
      expect(spectator.service.progress().inProgress).toBe(false);
    });
  });

  describe('token handling', () => {
    it('should use empty string when no token available', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      mockCredentialsService.getToken.mockReturnValue(null);

      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);

      expect(http.get).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('process multiple releases', () => {
    it('should process multiple releases with rate limiting', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      const releases = [
        mockReleaseNeedingData,
        {
          ...mockReleaseNeedingData,
          id: 125,
          basicInfo: { ...mockReleaseNeedingData.basicInfo, masterId: 1001 },
        },
        {
          ...mockReleaseNeedingData,
          id: 126,
          basicInfo: { ...mockReleaseNeedingData.basicInfo, masterId: 1002 },
        },
      ];

      db.getReleasesNeedingMasterData.mockResolvedValue(releases);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(of(mockMasterResponse));
      db.updateRelease.mockResolvedValue(1);

      spectator.service.startBackgroundFetch();

      // Wait for all releases to process (each has DISCOGS_API_DELAY_MS delay)
      await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 5);

      expect(http.get).toHaveBeenCalledTimes(3);
      expect(db.updateRelease).toHaveBeenCalledTimes(3);
      expect(spectator.service.progress().completed).toBe(3);

      consoleSpy.mockRestore();
    });
  });

  describe('master release sync setting', () => {
    it('should not start fetch when sync is disabled', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);

      db.isMasterReleaseSyncEnabled.mockResolvedValue(false);
      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);

      await spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(consoleSpy).toHaveBeenCalledWith('Master release sync is disabled');
      expect(spectator.service.progress().inProgress).toBe(false);

      consoleSpy.mockRestore();
    });

    it('should not resume when sync is disabled', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);

      db.isMasterReleaseSyncEnabled.mockResolvedValue(false);
      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);

      await spectator.service.resumeIfNeeded();

      expect(consoleSpy).toHaveBeenCalledWith('Master release sync is disabled, not resuming');
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Resuming master fetch'));

      consoleSpy.mockRestore();
    });

    it('should start fetch when sync is enabled', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const db = spectator.inject(DatabaseService);
      const http = spectator.inject(HttpClient);

      db.isMasterReleaseSyncEnabled.mockResolvedValue(true);
      db.getReleasesNeedingMasterData.mockResolvedValue([mockReleaseNeedingData]);
      db.getReleasesWithOriginalYearCount.mockResolvedValue(0);
      http.get.mockReturnValue(NEVER);

      await spectator.service.startBackgroundFetch();
      await jest.advanceTimersByTimeAsync(0);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Starting master fetch'));
      expect(spectator.service.progress().inProgress).toBe(true);

      consoleSpy.mockRestore();
    });
  });
});
