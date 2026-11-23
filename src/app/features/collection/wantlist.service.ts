import { Injectable, signal } from '@angular/core';

const REFRESH_AFTER_MS = 30_000;
const OWNER_KEY_STORAGE = 'wantlist-owner-key';
const OWNER_LINK_PREFIX = '#owner=';

function readOwnerKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    if (window.location.hash.startsWith(OWNER_LINK_PREFIX)) {
      const key = decodeURIComponent(window.location.hash.slice(OWNER_LINK_PREFIX.length));
      window.localStorage.setItem(OWNER_KEY_STORAGE, key);
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
    return window.localStorage.getItem(OWNER_KEY_STORAGE);
  } catch {
    return null;
  }
}

/**
 * The Discogs wantlist, loaded with one request. It is fetched again when the tab is shown
 * after a while, so pressings added or removed on Discogs in another tab show correctly.
 * Only devices unlocked with the owner link (`/#owner=<key>`) can see or change it.
 */
@Injectable({ providedIn: 'root' })
export class WantlistService {
  readonly wanted = signal<ReadonlySet<number> | null>(null);
  readonly pending = signal<ReadonlySet<number>>(new Set());
  readonly failed = signal(false);
  private loading: Promise<void> | null = null;
  private loadedAt = 0;
  private ownerKey = readOwnerKey();

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refreshIfStale();
    });
  }

  load(): Promise<void> {
    if (!this.ownerKey) return Promise.resolve();
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
      const response = await this.request(`/api/wantlist?releaseId=${releaseId}`, {
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

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: { 'X-Owner-Key': this.ownerKey ?? '' },
    });
    if (response.status === 401) this.lock();
    return response;
  }

  /** A wrong or replaced key hides the buttons instead of failing on every album. */
  private lock(): void {
    this.ownerKey = null;
    this.wanted.set(null);
    try {
      window.localStorage.removeItem(OWNER_KEY_STORAGE);
    } catch {
      // Storage can be unavailable in private browsing; the key is already dropped for this visit.
    }
  }

  private async fetchWanted(): Promise<void> {
    try {
      const response = await this.request('/api/wantlist');
      if (response.status === 401) return;
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
