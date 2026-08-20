import { createComponentFactory, Spectator } from '@ngneat/spectator/jest';
import { provideRouter, Router } from '@angular/router';
import { AppComponent } from './app.component';
import { DatabaseService } from './core/database.service';
import { CredentialsService } from './core/credentials.service';
import { MasterReleaseService } from './features/discogs/master-release.service';
import { PwaUpdateService } from './core/pwa-update.service';
import { AchievementsService } from './features/achievements/achievements.service';
import { CatalogService } from './core/catalog.service';
import { DiscogsConfigService } from './core/discogs-config.service';

describe('AppComponent', () => {
  let spectator: Spectator<AppComponent>;
  let mockCredentialsService: { hasCredentials: jest.Mock; setServerUsername: jest.Mock };

  const createComponent = createComponentFactory({
    component: AppComponent,
    detectChanges: false,
    mocks: [
      DatabaseService,
      MasterReleaseService,
      PwaUpdateService,
      AchievementsService,
      CatalogService,
      DiscogsConfigService,
    ],
    providers: [
      provideRouter([]),
      {
        provide: CredentialsService,
        useFactory: () => {
          mockCredentialsService = {
            hasCredentials: jest.fn().mockReturnValue(false),
            setServerUsername: jest.fn(),
          };
          return mockCredentialsService;
        },
      },
    ],
  });

  beforeEach(() => {
    spectator = createComponent();
    spectator.inject(DiscogsConfigService).load.mockResolvedValue({ configured: false });
    spectator.inject(CatalogService).load.mockResolvedValue(null);
    const router = spectator.inject(Router);
    jest.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  it('should create', () => {
    expect(spectator.component).toBeTruthy();
  });

  it('should render router-outlet', () => {
    expect(spectator.query('router-outlet')).toBeTruthy();
  });

  describe('ngOnInit', () => {
    it('should initialize PWA service', async () => {
      const pwaService = spectator.inject(PwaUpdateService);

      await spectator.component.ngOnInit();

      expect(pwaService.initialize).toHaveBeenCalled();
    });

    it('should navigate to /setup when no credentials', async () => {
      const router = spectator.inject(Router);
      mockCredentialsService.hasCredentials.mockReturnValue(false);

      await spectator.component.ngOnInit();

      expect(router.navigate).toHaveBeenCalledWith(['/setup']);
    });

    it('should navigate to /collection with configured server credentials and no local credentials', async () => {
      const router = spectator.inject(Router);
      const config = spectator.inject(DiscogsConfigService);
      const catalogService = spectator.inject(CatalogService);
      config.load.mockResolvedValue({ configured: true, username: 'server-user' });
      catalogService.load.mockResolvedValue({ schemaVersion: 1, updatedAt: '', releases: [] });
      mockCredentialsService.hasCredentials.mockReturnValue(false);

      await spectator.component.ngOnInit();

      expect(router.navigate).toHaveBeenCalledWith(['/collection']);
      expect(router.navigate).not.toHaveBeenCalledWith(['/setup']);
    });

    it('should load an existing server catalog before deciding whether to sync', async () => {
      const router = spectator.inject(Router);
      const db = spectator.inject(DatabaseService);
      const config = spectator.inject(DiscogsConfigService);
      const catalogService = spectator.inject(CatalogService);
      mockCredentialsService.hasCredentials.mockReturnValue(false);
      config.load.mockResolvedValue({ configured: true, username: 'server-user' });
      catalogService.load.mockResolvedValue({
        schemaVersion: 1,
        updatedAt: '2026-08-20T00:00:00.000Z',
        releases: [
          {
            id: 1,
            instanceId: 10,
            basicInfo: { title: 'Album', artists: ['Artist'], formats: ['LP'] },
          },
        ],
      });
      db.getCollectionCount.mockResolvedValue(0);

      await spectator.component.ngOnInit();

      expect(db.addRelease).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/collection']);
    });

    it('should synchronize an empty configured catalog and bypass /sync', async () => {
      const router = spectator.inject(Router);
      const db = spectator.inject(DatabaseService);
      const config = spectator.inject(DiscogsConfigService);
      const catalogService = spectator.inject(CatalogService);
      mockCredentialsService.hasCredentials.mockReturnValue(false);
      config.load.mockResolvedValue({ configured: true, username: 'server-user' });
      catalogService.load
        .mockResolvedValueOnce({ schemaVersion: 1, updatedAt: '', releases: [] })
        .mockResolvedValueOnce({
          schemaVersion: 1,
          updatedAt: '2026-08-20T00:00:00.000Z',
          releases: [
            {
              id: 2,
              instanceId: 20,
              basicInfo: { title: 'Synced Album', artists: ['Artist'], formats: ['LP'] },
            },
          ],
        });
      db.getCollectionCount.mockResolvedValue(0);

      await spectator.component.ngOnInit();

      expect(catalogService.write).toHaveBeenCalledTimes(1);
      expect(db.addRelease).toHaveBeenCalled();
      expect(router.navigate).toHaveBeenCalledWith(['/collection']);
      expect(router.navigate).not.toHaveBeenCalledWith(['/sync']);
    });

    it('should navigate to /sync when credentials exist but no data', async () => {
      const router = spectator.inject(Router);
      const db = spectator.inject(DatabaseService);
      const config = spectator.inject(DiscogsConfigService);
      mockCredentialsService.hasCredentials.mockReturnValue(true);
      config.load.mockResolvedValue({ configured: false });
      db.getCollectionCount.mockResolvedValue(0);

      await spectator.component.ngOnInit();

      expect(router.navigate).toHaveBeenCalledWith(['/sync']);
    });

    it('should navigate to /collection when credentials and data exist', async () => {
      const router = spectator.inject(Router);
      const db = spectator.inject(DatabaseService);
      mockCredentialsService.hasCredentials.mockReturnValue(true);
      db.getCollectionCount.mockResolvedValue(5);
      db.getAllReleases.mockResolvedValue([]);

      await spectator.component.ngOnInit();

      expect(router.navigate).toHaveBeenCalledWith(['/collection']);
    });

    it('should resume master release service and initialize achievements for returning users', async () => {
      const db = spectator.inject(DatabaseService);
      const masterReleaseService = spectator.inject(MasterReleaseService);
      const achievementsService = spectator.inject(AchievementsService);
      const mockReleases = [{ id: 1 }];
      mockCredentialsService.hasCredentials.mockReturnValue(true);
      db.getCollectionCount.mockResolvedValue(5);
      db.getAllReleases.mockResolvedValue(mockReleases);

      await spectator.component.ngOnInit();

      expect(masterReleaseService.resumeIfNeeded).toHaveBeenCalled();
      expect(achievementsService.initialize).toHaveBeenCalledWith(mockReleases);
    });

    it('should not check database when no credentials', async () => {
      const db = spectator.inject(DatabaseService);
      mockCredentialsService.hasCredentials.mockReturnValue(false);
      db.getCollectionCount.mockClear();

      await spectator.component.ngOnInit();

      expect(db.getCollectionCount).not.toHaveBeenCalled();
    });
  });
});
