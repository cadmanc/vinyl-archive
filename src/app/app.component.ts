import { Component, OnInit } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { DatabaseService } from './core/database.service';
import { CredentialsService } from './core/credentials.service';
import { MasterReleaseService } from './features/discogs/master-release.service';
import { PwaUpdateService } from './core/pwa-update.service';
import { AchievementsService } from './features/achievements/achievements.service';
import { DiscogsConfigService } from './core/discogs-config.service';
import { CatalogDocument, CatalogRelease, CatalogService } from './core/catalog.service';
import { Release } from './shared/models/release.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet></router-outlet>',
})
export class AppComponent implements OnInit {
  constructor(
    private db: DatabaseService,
    private credentialsService: CredentialsService,
    private masterReleaseService: MasterReleaseService,
    private pwaUpdateService: PwaUpdateService,
    private achievementsService: AchievementsService,
    private discogsConfigService: DiscogsConfigService,
    private catalogService: CatalogService,
    private router: Router,
  ) {}

  async ngOnInit() {
    this.pwaUpdateService.initialize();
    await this.navigateBasedOnState();
  }

  private async navigateBasedOnState() {
    const serverConfig = await this.discogsConfigService.load();
    this.credentialsService.setServerUsername(
      serverConfig.configured ? (serverConfig.username ?? null) : null,
    );

    if (!serverConfig.configured && !this.credentialsService.hasCredentials()) {
      this.router.navigate(['/setup']);
      return;
    }

    let catalog = await this.catalogService.load();
    const hadPopulatedCatalog = Boolean(catalog?.releases.length);
    if (!catalog?.releases.length && serverConfig.configured) {
      try {
        await this.catalogService.write();
        catalog = await this.catalogService.load();
      } catch (error) {
        console.error('Failed to synchronize the server catalog:', error);
      }
    }
    let importedCatalog = false;
    if (catalog?.releases.length) {
      importedCatalog = true;
      const localReleases = (await this.db.getAllReleases()) ?? [];
      const localById = new Map(localReleases.map((release) => [release.id, release]));
      for (const stored of catalog.releases) {
        const local = localById.get(stored.id);
        if (local) {
          await this.db.updateRelease(stored.id, {
            instanceId: stored.instanceId,
            basicInfo: { ...stored.basicInfo, ...local.basicInfo },
          });
        } else {
          await this.db.addRelease(this.catalogReleaseToRelease(stored));
        }
      }
    }

    const count = await this.db.getCollectionCount();
    if (count === 0 && !importedCatalog && !serverConfig.configured) {
      this.router.navigate(['/sync']);
      return;
    }

    // Resume background services for returning users
    this.masterReleaseService.startReleaseDetailEnrichment();
    this.masterReleaseService.resumeIfNeeded();
    const releases = await this.db.getAllReleases();
    this.achievementsService.initialize(releases);
    this.router.navigate(['/collection']);

    if (serverConfig.configured && hadPopulatedCatalog && catalog?.releases.length) {
      void this.reconcileCatalog(catalog);
    }
  }

  private async reconcileCatalog(previousCatalog: CatalogDocument): Promise<void> {
    try {
      await this.catalogService.write();
      const refreshedCatalog = await this.catalogService.load();
      if (!refreshedCatalog) return;

      const knownIds = new Set(previousCatalog.releases.map((release) => release.id));
      const localReleases = (await this.db.getAllReleases()) ?? [];
      const localIds = new Set(localReleases.map((release) => release.id));
      const addedReleases: Release[] = [];

      for (const stored of refreshedCatalog.releases) {
        if (knownIds.has(stored.id) || localIds.has(stored.id)) continue;
        const release = this.catalogReleaseToRelease(stored);
        await this.db.addRelease(release);
        addedReleases.push(release);
      }

      if (addedReleases.length) {
        void this.masterReleaseService.startReleaseDetailEnrichmentFor(addedReleases);
      }
    } catch (error) {
      console.error('Failed to reconcile the server catalog in the background:', error);
    }
  }

  private catalogReleaseToRelease(stored: CatalogRelease): Release {
    return {
      ...stored,
      playCount: 0,
      dateAdded: new Date(),
    };
  }
}
