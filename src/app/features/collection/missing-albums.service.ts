import { Injectable } from '@angular/core';
import { SAVED_DATA_URL, fetchSaved } from '../../core/saved-data';

export interface MissingAlbum {
  masterId: number;
  title: string;
  year?: number;
  kind?: 'album' | 'ep' | 'compilation';
}

export function missingAlbumLabel(album: MissingAlbum): string {
  if (album.kind === 'ep') return `${album.title} (EP)`;
  if (album.kind === 'compilation') return `${album.title} (Compilation)`;
  return album.title;
}

export interface VinylPressing {
  releaseId: number;
  year?: number;
  country?: string;
  label?: string;
  catno?: string;
  discs?: number;
  descriptions: string[];
  details?: string;
  detailed?: boolean;
}

// Shown in the line's own position (disc count) or implied by every vinyl album.
const HIDDEN_DESCRIPTIONS = new Set(['LP', 'Album', 'Compilation', 'Stereo', '12"', '33 ⅓ RPM']);

export function pressingSummary(pressing: VinylPressing): string {
  const origin = [pressing.year ?? 'Year unknown', pressing.country].filter(Boolean).join(' ');
  const tags = pressing.descriptions.filter((description) => !HIDDEN_DESCRIPTIONS.has(description));
  const discs = pressing.discs && pressing.discs > 1 ? `${pressing.discs}LP` : 'LP';
  return [origin, ...tags, pressing.details, discs].filter(Boolean).join(' · ');
}

export function pressingLabel(pressing: VinylPressing): string {
  return [pressing.label, pressing.catno].filter(Boolean).join(' · ');
}

export interface MissingAlbumsSummary {
  artists: Record<
    string,
    { complete: boolean; albums: MissingAlbum[] | null; checked?: number; total?: number }
  >;
}

/** Matches the key the missing albums workflow uses for an artist credit in the collection. */
export function artistCreditKey(artists: string[]): string {
  return artists.join('|');
}

const SUMMARY_URL = `${SAVED_DATA_URL}/summary.json`;
const PRESSINGS_STORAGE_PREFIX = 'missing-albums-pressings:';
const PRESSINGS_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// A master with hundreds of pressings needs several batches; this stops a runaway loop.
const MAX_PRESSING_BATCHES = 30;

export function sortPressings(pressings: VinylPressing[]): VinylPressing[] {
  return [...pressings].sort(
    (left, right) =>
      (left.year ?? Infinity) - (right.year ?? Infinity) || left.releaseId - right.releaseId,
  );
}

@Injectable({ providedIn: 'root' })
export class MissingAlbumsService {
  async loadSummary(): Promise<MissingAlbumsSummary> {
    const response = await fetch(SUMMARY_URL, { cache: 'no-cache' });
    // Nothing is published until the workflow's first run finishes a batch of artists.
    if (response.status === 404) return { artists: {} };
    if (!response.ok) throw new Error(`Missing albums summary failed with ${response.status}`);
    return (await response.json()) as MissingAlbumsSummary;
  }

  /**
   * Pressings come from the copy the scheduled job saves on GitHub. Until the job reaches an
   * album, they're looked up once and kept in this browser.
   */
  async loadPressings(masterId: number): Promise<VinylPressing[]> {
    const published = await fetchSaved<{ next: number | null; pressings: VinylPressing[] }>(
      `${SAVED_DATA_URL}/pressings/master-${masterId}.json`,
    ).catch(() => null);
    if (published && published.next === null) return published.pressings;
    const saved = this.savedPressings(masterId);
    if (saved) return saved;

    const detailed = new Map<number, VinylPressing>();
    let pressings: VinylPressing[] = [];
    let from: number | null = 0;
    for (let batch = 0; from !== null && batch < MAX_PRESSING_BATCHES; batch++) {
      const result: { pressings: VinylPressing[]; next: number | null } = await this.request(
        `/api/missing-albums?masterId=${masterId}&from=${from}`,
      );
      for (const pressing of result.pressings) {
        if (pressing.detailed) detailed.set(pressing.releaseId, pressing);
      }
      pressings = result.pressings.map((pressing) => detailed.get(pressing.releaseId) ?? pressing);
      from = result.next;
    }
    pressings = sortPressings(pressings);
    if (from === null) this.savePressings(masterId, pressings);
    return pressings;
  }

  private savedPressings(masterId: number): VinylPressing[] | null {
    try {
      const raw = localStorage.getItem(PRESSINGS_STORAGE_PREFIX + masterId);
      if (!raw) return null;
      const saved = JSON.parse(raw) as { savedAt: number; pressings: VinylPressing[] };
      return Date.now() - saved.savedAt < PRESSINGS_KEEP_MS ? saved.pressings : null;
    } catch {
      return null;
    }
  }

  private savePressings(masterId: number, pressings: VinylPressing[]): void {
    try {
      localStorage.setItem(
        PRESSINGS_STORAGE_PREFIX + masterId,
        JSON.stringify({ savedAt: Date.now(), pressings }),
      );
    } catch {
      // Storage full or unavailable; the pressings are simply fetched again next time.
    }
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`Missing albums request failed with ${response.status}`);
    return (await response.json()) as T;
  }
}
