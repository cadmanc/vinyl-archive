import { Injectable, signal } from '@angular/core';
import { forgetOwnerKey, readOwnerKey } from '../../core/owner-key';
import {
  OWNER_DATA_URL,
  fetchSaved,
  recentOwnerChange,
  rememberOwnerChange,
} from '../../core/saved-data';

const SAVED_WANTLIST = 'wantlist';

/**
 * The Discogs wantlist as saved on GitHub, so showing it never asks Discogs. The daily job
 * picks up changes made on Discogs; changes made here are saved straight away.
 * Anyone can see it; only devices unlocked with the owner link (`/#owner=<key>`) can change it.
 */
@Injectable({ providedIn: 'root' })
export class WantlistService {
  readonly wanted = signal<ReadonlySet<number> | null>(null);
  readonly pending = signal<ReadonlySet<number>>(new Set());
  readonly failed = signal(false);
  private ownerKey = readOwnerKey();
  readonly canEdit = signal(this.ownerKey !== null);
  private loading: Promise<void> | null = null;

  load(): Promise<void> {
    this.loading ??= this.fetchWanted();
    return this.loading;
  }

  isWanted(releaseId: number): boolean {
    return this.wanted()?.has(releaseId) ?? false;
  }

  isPending(releaseId: number): boolean {
    return this.pending().has(releaseId);
  }

  async toggle(releaseId: number): Promise<void> {
    if (!this.canEdit() || this.wanted() === null || this.isPending(releaseId)) return;
    const wanted = this.isWanted(releaseId);
    this.pending.update((current) => new Set(current).add(releaseId));
    try {
      const response = await fetch(`/api/wantlist?releaseId=${releaseId}`, {
        method: wanted ? 'DELETE' : 'PUT',
        headers: { 'X-Owner-Key': this.ownerKey ?? '' },
      });
      if (response.status === 401) this.lock();
      if (!response.ok) throw new Error(`Wantlist update failed with ${response.status}`);
      const next = new Set(this.wanted());
      if (wanted) next.delete(releaseId);
      else next.add(releaseId);
      this.wanted.set(next);
      rememberOwnerChange(SAVED_WANTLIST, [...next]);
    } catch (error) {
      console.error('Failed to update the Discogs wantlist:', error);
    } finally {
      this.pending.update((current) => {
        const next = new Set(current);
        next.delete(releaseId);
        return next;
      });
    }
  }

  /** A wrong or replaced key makes the buttons read-only instead of failing on every click. */
  private lock(): void {
    this.ownerKey = null;
    this.canEdit.set(false);
    forgetOwnerKey();
  }

  private async fetchWanted(): Promise<void> {
    try {
      const saved = await fetchSaved<{ releaseIds: number[] }>(`${OWNER_DATA_URL}/wantlist.json`);
      const releaseIds = recentOwnerChange<number[]>(SAVED_WANTLIST) ?? saved?.releaseIds ?? [];
      this.wanted.set(new Set(releaseIds));
      this.failed.set(false);
    } catch (error) {
      console.error('Failed to load the saved wantlist:', error);
      this.failed.set(true);
      this.loading = null;
    }
  }
}
