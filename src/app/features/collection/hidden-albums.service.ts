import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'hidden-missing-albums';

function readHidden(): Set<number> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)) : []);
  } catch {
    return new Set();
  }
}

/** Missing albums the user never wants, by master ID. Saved on this device only. */
@Injectable({ providedIn: 'root' })
export class HiddenAlbumsService {
  readonly hidden = signal<ReadonlySet<number>>(readHidden());

  isHidden(masterId: number): boolean {
    return this.hidden().has(masterId);
  }

  hide(masterId: number): void {
    this.save(new Set(this.hidden()).add(masterId));
  }

  unhide(masterId: number): void {
    const next = new Set(this.hidden());
    next.delete(masterId);
    this.save(next);
  }

  private save(next: Set<number>): void {
    this.hidden.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch (error) {
      console.error('Failed to save hidden albums:', error);
    }
  }
}
