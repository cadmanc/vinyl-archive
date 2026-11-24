import { Injectable, signal } from '@angular/core';
import { readOwnerKey } from '../../core/owner-key';

export interface CollectionValue {
  low: string;
  typical: string;
  high: string;
}

/** Discogs' estimate of the collection's worth, loaded once per visit on the owner's devices. */
@Injectable({ providedIn: 'root' })
export class CollectionValueService {
  readonly value = signal<CollectionValue | null>(null);
  private loading: Promise<void> | null = null;

  load(): Promise<void> {
    this.loading ??= this.fetchValue();
    return this.loading;
  }

  private async fetchValue(): Promise<void> {
    const ownerKey = readOwnerKey();
    if (!ownerKey) return;
    try {
      const response = await fetch('/api/collection-value', {
        headers: { 'X-Owner-Key': ownerKey },
      });
      if (!response.ok) throw new Error(`Collection value request failed with ${response.status}`);
      this.value.set((await response.json()) as CollectionValue);
    } catch (error) {
      console.error('Failed to load the collection value:', error);
    }
  }
}
