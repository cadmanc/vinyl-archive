import { Component, OnInit } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { DatabaseService } from './core/database.service';
import { CredentialsService } from './core/credentials.service';
import { MasterReleaseService } from './features/discogs/master-release.service';
import { PwaUpdateService } from './core/pwa-update.service';
import { AchievementsService } from './features/achievements/achievements.service';
import { DiscogsConfigService } from './core/discogs-config.service';
import { CatalogRelease, CatalogService, groupCatalogCopies } from './core/catalog.service';
import { Release } from './shared/models/release.model';

/**
 * The saved catalog is checked on a schedule, so its details win once it has them; until
 * then, details this browser already looked up are kept.
 */
export function mergeBasicInfo(
  local: Release['basicInfo'],
  stored: Release['basicInfo'],
): Release['basicInfo'] {
  return stored.detailsFetched ? { ...local, ...stored } : { ...stored, ...local };
}

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

    const catalog = await this.catalogService.load();
    let importedCatalog = false;
    if (catalog?.releases.length) {
      importedCatalog = true;
      const localReleases = (await this.db.getAllReleases()) ?? [];
      const localById = new Map(localReleases.map((release) => [release.id, release]));
      for (const { release: stored, copies } of groupCatalogCopies(catalog.releases)) {
        const local = localById.get(stored.id);
        if (local) {
          await this.db.updateRelease(stored.id, {
            instanceId: stored.instanceId,
            copies,
            basicInfo: mergeBasicInfo(local.basicInfo, stored.basicInfo),
          });
        } else {
          await this.db.addRelease({ ...this.catalogReleaseToRelease(stored), copies });
        }
      }
      await this.db.removeReleasesNotIn(new Set(catalog.releases.map((release) => release.id)));
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
  }

  private catalogReleaseToRelease(stored: CatalogRelease): Release {
    return {
      ...stored,
      playCount: 0,
      dateAdded: new Date(),
    };
  }
}
