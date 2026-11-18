import { Injectable } from '@angular/core';
import type { Release, ReleaseEnrichment } from '../shared/models/release.model';

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

@Injectable({ providedIn: 'root' })
export class CatalogService {
  private enrichmentWriteQueue = Promise.resolve();

  constructor() {}

  async load(): Promise<CatalogDocument | null> {
    try {
      const response = await fetch('/api/catalog');
      if (!response.ok) return null;
      return (await response.json()) as CatalogDocument;
    } catch (error) {
      console.error('Failed to load server catalog:', error);
      return null;
    }
  }

  async write(): Promise<void> {
    const response = await fetch('/api/catalog-sync', {
      method: 'POST',
    });
    if (!response.ok) throw new Error('Catalog could not be written');
  }

  async writeEnrichment(releaseId: number, enrichment: ReleaseEnrichment): Promise<void> {
    const write = this.enrichmentWriteQueue.then(async () => {
      const response = await fetch('/api/catalog-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseId, enrichment }),
      });
      if (!response.ok) throw new Error('Catalog enrichment could not be written');
    });
    this.enrichmentWriteQueue = write.catch(() => undefined);
    return write;
  }
}
