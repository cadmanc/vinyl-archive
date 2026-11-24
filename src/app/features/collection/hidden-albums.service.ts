import { Injectable, signal } from '@angular/core';
import { forgetOwnerKey, readOwnerKey } from '../../core/owner-key';
import {
  OWNER_DATA_URL,
  fetchSaved,
  recentOwnerChange,
  rememberOwnerChange,
} from '../../core/saved-data';

const SAVED_HIDDEN = 'hidden-albums';
const DEVICE_HIDDEN_STORAGE = 'hidden-missing-albums';

/**
 * Missing albums the owner never wants, by master ID, saved on GitHub so every browser
 * leaves them out. Only devices unlocked with the owner link can hide or unhide.
 */
@Injectable({ providedIn: 'root' })
export class HiddenAlbumsService {
  readonly hidden = signal<ReadonlySet<number>>(new Set());
  readonly pending = signal<ReadonlySet<number>>(new Set());
  private ownerKey = readOwnerKey();
  readonly canEdit = signal(this.ownerKey !== null);
  private loading: Promise<void> | null = null;

  load(): Promise<void> {
    this.loading ??= this.fetchHidden();
    return this.loading;
  }

  isHidden(masterId: number): boolean {
    return this.hidden().has(masterId);
  }

  isPending(masterId: number): boolean {
    return this.pending().has(masterId);
  }

  hide(masterId: number): Promise<void> {
    return this.change(masterId, true);
  }

  unhide(masterId: number): Promise<void> {
    return this.change(masterId, false);
  }

  private async change(masterId: number, hide: boolean): Promise<void> {
    if (!this.canEdit() || this.isPending(masterId)) return;
    this.pending.update((current) => new Set(current).add(masterId));
    try {
      const response = await fetch(`/api/hidden-albums?masterId=${masterId}`, {
        method: hide ? 'PUT' : 'DELETE',
        headers: { 'X-Owner-Key': this.ownerKey ?? '' },
      });
      if (response.status === 401) this.lock();
      if (!response.ok) throw new Error(`Hidden albums update failed with ${response.status}`);
      const { masterIds } = (await response.json()) as { masterIds: number[] };
      this.hidden.set(new Set(masterIds));
      rememberOwnerChange(SAVED_HIDDEN, masterIds);
    } catch (error) {
      console.error('Failed to save hidden albums:', error);
    } finally {
      this.pending.update((current) => {
        const next = new Set(current);
        next.delete(masterId);
        return next;
      });
    }
  }

  private lock(): void {
    this.ownerKey = null;
    this.canEdit.set(false);
    forgetOwnerKey();
  }

  private async fetchHidden(): Promise<void> {
    try {
      const saved = await fetchSaved<{ masterIds: number[] }>(
        `${OWNER_DATA_URL}/hidden-albums.json`,
      );
      const masterIds = recentOwnerChange<number[]>(SAVED_HIDDEN) ?? saved?.masterIds ?? [];
      this.hidden.set(new Set(masterIds));
      await this.uploadDeviceHidden();
    } catch (error) {
      console.error('Failed to load hidden albums:', error);
      this.loading = null;
    }
  }

  /** Albums hidden when hiding was saved per device move to the shared list. */
  private async uploadDeviceHidden(): Promise<void> {
    if (!this.canEdit()) return;
    let ids: unknown;
    try {
      ids = JSON.parse(localStorage.getItem(DEVICE_HIDDEN_STORAGE) ?? 'null');
    } catch {
      ids = null;
    }
    if (!Array.isArray(ids)) return;
    for (const id of ids) {
      if (Number.isInteger(id) && !this.isHidden(id)) await this.hide(id);
    }
    if (ids.every((id) => !Number.isInteger(id) || this.isHidden(id))) {
      try {
        localStorage.removeItem(DEVICE_HIDDEN_STORAGE);
      } catch {
        // Uploaded already; the leftover copy is skipped next time.
      }
    }
  }
}
