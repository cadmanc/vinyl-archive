import { Injectable, signal } from '@angular/core';

const REFRESH_AFTER_MS = 30_000;

/**
 * The Discogs wantlist, loaded with one request. It is fetched again when the tab is shown
 * after a while, so pressings added or removed on Discogs in another tab show correctly.
 */
@Injectable({ providedIn: 'root' })
export class WantlistService {
  readonly wanted = signal<ReadonlySet<number> | null>(null);
  readonly pending = signal<ReadonlySet<number>>(new Set());
  readonly failed = signal(false);
  private loading: Promise<void> | null = null;
  private loadedAt = 0;

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refreshIfStale();
    });
  }

  load(): Promise<void> {
    this.loading ??= this.fetchWanted();
    return this.loading;
  }

  async refreshIfStale(): Promise<void> {
    if (this.wanted() === null || Date.now() - this.loadedAt < REFRESH_AFTER_MS) return;
    this.loading = this.fetchWanted();
    await this.loading;
  }

  isWanted(releaseId: number): boolean {
    return this.wanted()?.has(releaseId) ?? false;
  }

  isPending(releaseId: number): boolean {
    return this.pending().has(releaseId);
  }

  async toggle(releaseId: number): Promise<void> {
    if (this.wanted() === null || this.isPending(releaseId)) return;
    const wanted = this.isWanted(releaseId);
    this.pending.update((current) => new Set(current).add(releaseId));
    try {
      const response = await fetch(`/api/wantlist?releaseId=${releaseId}`, {
        method: wanted ? 'DELETE' : 'PUT',
      });
      if (!response.ok) throw new Error(`Wantlist update failed with ${response.status}`);
      this.wanted.update((current) => {
        const next = new Set(current);
        if (wanted) next.delete(releaseId);
        else next.add(releaseId);
        return next;
      });
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

  private async fetchWanted(): Promise<void> {
    try {
      const response = await fetch('/api/wantlist');
      if (!response.ok) throw new Error(`Wantlist request failed with ${response.status}`);
      const { releaseIds } = (await response.json()) as { releaseIds: number[] };
      this.wanted.set(new Set(releaseIds));
      this.loadedAt = Date.now();
      this.failed.set(false);
    } catch (error) {
      console.error('Failed to load the Discogs wantlist:', error);
      this.failed.set(true);
      this.loading = null;
    }
  }
}
