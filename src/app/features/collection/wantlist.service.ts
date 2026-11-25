import { Injectable, signal } from '@angular/core';
import { forgetOwnerKey, readOwnerKey } from '../../core/owner-key';
import {
  OWNER_DATA_URL,
  fetchSaved,
  recentOwnerChange,
  rememberOwnerChange,
} from '../../core/saved-data';

const SAVED_WANTLIST = 'wantlist';

type SavedWantlist = {
  releaseIds: number[];
  byMaster?: Record<string, number[]>;
};

/**
 * The Discogs wantlist as saved on GitHub, so showing it never asks Discogs. The daily job
 * picks up changes made on Discogs; changes made here are saved straight away.
 * Anyone can see it; only devices unlocked with the owner link (`/#owner=<key>`) can change it.
 */
@Injectable({ providedIn: 'root' })
export class WantlistService {
  readonly wanted = signal<ReadonlySet<number> | null>(null);
  /** Masters with at least one wanted pressing — drives the green dots on missing albums. */
  readonly wantedMasters = signal<ReadonlySet<number>>(new Set());
  readonly pending = signal<ReadonlySet<number>>(new Set());
  readonly failed = signal(false);
  private byMaster = new Map<number, Set<number>>();
  private ownerKey = readOwnerKey();
  readonly canEdit = signal(this.ownerKey !== null);
  private loading: Promise<void> | null = null;

  load(force = false): Promise<void> {
    if (force) this.loading = null;
    this.loading ??= this.fetchWanted();
    return this.loading;
  }

  isWanted(releaseId: number): boolean {
    return this.wanted()?.has(releaseId) ?? false;
  }

  isWantedMaster(masterId: number): boolean {
    return this.wantedMasters().has(masterId);
  }

  isPending(releaseId: number): boolean {
    return this.pending().has(releaseId);
  }

  async toggle(releaseId: number, masterId?: number): Promise<void> {
    if (!this.canEdit() || this.wanted() === null || this.isPending(releaseId)) return;
    const wanted = this.isWanted(releaseId);
    this.pending.update((current) => new Set(current).add(releaseId));
    try {
      const params = new URLSearchParams({ releaseId: String(releaseId) });
      if (masterId) params.set('masterId', String(masterId));
      const response = await fetch(`/api/wantlist?${params}`, {
        method: wanted ? 'DELETE' : 'PUT',
        headers: { 'X-Owner-Key': this.ownerKey ?? '' },
      });
      if (response.status === 401) this.lock();
      if (!response.ok) throw new Error(`Wantlist update failed with ${response.status}`);
      const next = new Set(this.wanted());
      if (wanted) next.delete(releaseId);
      else next.add(releaseId);
      this.wanted.set(next);
      this.applyMasterChange(releaseId, !wanted, masterId);
      rememberOwnerChange(SAVED_WANTLIST, this.snapshot());
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

  private applyMasterChange(releaseId: number, wanted: boolean, masterId?: number): void {
    if (masterId && masterId > 0) {
      const ids = new Set(this.byMaster.get(masterId) ?? []);
      if (wanted) ids.add(releaseId);
      else ids.delete(releaseId);
      if (ids.size) this.byMaster.set(masterId, ids);
      else this.byMaster.delete(masterId);
    } else if (!wanted) {
      for (const [id, releases] of [...this.byMaster]) {
        releases.delete(releaseId);
        if (!releases.size) this.byMaster.delete(id);
      }
    }
    this.wantedMasters.set(new Set(this.byMaster.keys()));
  }

  private snapshot(): SavedWantlist {
    const byMaster: Record<string, number[]> = {};
    for (const [masterId, releaseIds] of this.byMaster) {
      byMaster[String(masterId)] = [...releaseIds].sort((a, b) => a - b);
    }
    return {
      releaseIds: [...(this.wanted() ?? [])].sort((a, b) => a - b),
      ...(Object.keys(byMaster).length ? { byMaster } : {}),
    };
  }

  private readByMaster(saved: SavedWantlist | null | undefined): void {
    this.byMaster = new Map();
    for (const [key, releaseIds] of Object.entries(saved?.byMaster ?? {})) {
      const masterId = Number(key);
      if (!Number.isInteger(masterId) || masterId <= 0 || !releaseIds.length) continue;
      this.byMaster.set(masterId, new Set(releaseIds));
    }
    this.wantedMasters.set(new Set(this.byMaster.keys()));
  }

  private async fetchWanted(): Promise<void> {
    try {
      const saved = await fetchSaved<SavedWantlist>(`${OWNER_DATA_URL}/wantlist.json`);
      const recent = recentOwnerChange<SavedWantlist | number[]>(SAVED_WANTLIST);
      const file: SavedWantlist = Array.isArray(recent)
        ? { releaseIds: recent }
        : (recent ?? saved ?? { releaseIds: [] });
      this.wanted.set(new Set(file.releaseIds ?? []));
      this.readByMaster(file);
      this.failed.set(false);
    } catch (error) {
      console.error('Failed to load the saved wantlist:', error);
      this.failed.set(true);
      this.loading = null;
    }
  }
}
