import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { CredentialsService } from '../core/credentials.service';
import { DatabaseService } from '../core/database.service';
import { DiscogsConfigService } from './discogs-config.service';

export const syncGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const credentialsService = inject(CredentialsService);
  const discogsConfigService = inject(DiscogsConfigService);
  const router = inject(Router);
  const serverConfig = await discogsConfigService.load();
  credentialsService.setServerUsername(
    serverConfig.configured ? (serverConfig.username ?? null) : null,
  );

  if (serverConfig.configured || credentialsService.hasCredentials()) {
    return true;
  }
  return router.createUrlTree(['/setup']);
};

export const playerGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const credentialsService = inject(CredentialsService);
  const db = inject(DatabaseService);
  const discogsConfigService = inject(DiscogsConfigService);
  const router = inject(Router);
  const serverConfig = await discogsConfigService.load();
  credentialsService.setServerUsername(
    serverConfig.configured ? (serverConfig.username ?? null) : null,
  );

  if (!serverConfig.configured && !credentialsService.hasCredentials()) {
    return router.createUrlTree(['/setup']);
  }

  const count = await db.getCollectionCount();
  if (count === 0 && !serverConfig.configured) {
    return router.createUrlTree(['/sync']);
  }

  return true;
};
