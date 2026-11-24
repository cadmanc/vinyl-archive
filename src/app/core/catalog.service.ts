import { Injectable } from '@angular/core';
import type { Release } from '../shared/models/release.model';
import { SAVED_DATA_URL, fetchSaved } from './saved-data';

if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = (() => Promise.reject(new Error('fetch is unavailable'))) as typeof fetch;
}

export type CatalogRelease = Pick<Release, 'id' | 'instanceId' | 'basicInfo'>;

export interface CatalogDocument {
  schemaVersion: 1;
  updatedAt: string;
  releases: CatalogRelease[];
}

/**
 * The catalog lists one entry per owned copy, so the same release ID can repeat.
 * Returns each release once, in catalog order, with how many copies are owned.
 */
export function groupCatalogCopies(
  releases: CatalogRelease[],
): Array<{ release: CatalogRelease; copies: number }> {
  const grouped = new Map<number, { release: CatalogRelease; copies: number }>();
  for (const release of releases) {
    const entry = grouped.get(release.id);
    if (entry) {
      entry.copies++;
    } else {
      grouped.set(release.id, { release, copies: 1 });
    }
  }
  return [...grouped.values()];
}

/** Saved on GitHub by the scheduled refresh workflow, with every record's details. */
const SAVED_CATALOG_URL = `${SAVED_DATA_URL}/catalog.json`;

@Injectable({ providedIn: 'root' })
export class CatalogService {
  /** The saved catalog, or the site's live Discogs copy before the first saved one exists. */
  async load(): Promise<CatalogDocument | null> {
    try {
      const saved = await fetchSaved<CatalogDocument>(SAVED_CATALOG_URL);
      if (saved?.releases.length) return saved;
    } catch (error) {
      console.error('Failed to load the saved catalog:', error);
    }
    try {
      const response = await fetch('/api/catalog');
      if (!response.ok) return null;
      return (await response.json()) as CatalogDocument;
    } catch (error) {
      console.error('Failed to load server catalog:', error);
      return null;
    }
  }
}
