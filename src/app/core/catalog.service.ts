import { Injectable } from '@angular/core';
import type { Release } from '../shared/models/release.model';

if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = (() => Promise.reject(new Error('fetch is unavailable'))) as typeof fetch;
}

export type CatalogRelease = Pick<Release, 'id' | 'instanceId' | 'basicInfo'>;

export interface CatalogDocument {
  schemaVersion: 1;
  updatedAt: string;
  releases: CatalogRelease[];
}

@Injectable({ providedIn: 'root' })
export class CatalogService {
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
}
