/**
 * Saves the official vinyl pressings of every missing album to pressings/master-<id>.json,
 * so opening an album on the site shows them without asking Discogs. Colour and weight need
 * one request per pressing, so a big album can take several runs; progress is kept in the
 * file (`next`) and picked up where it stopped.
 */
import {
  isOfficialVersion,
  sortPressings,
  toPressing,
  type DiscogsMasterVersion,
  type DiscogsMasterVersionsPage,
  type DiscogsReleaseDetail,
  type VinylPressing,
} from '../api/missing-albums.js';
import type { Get } from './catalog-refresh.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// New reissues of older albums turn up slowly; recent albums get new pressings often.
const RECHECK_MS = 90 * DAY_MS;
const RECENT_RECHECK_MS = 14 * DAY_MS;

export interface PressingsFile {
  cachedAt: string;
  /** Index of the first pressing still missing its details, or null when complete. */
  next: number | null;
  versions: DiscogsMasterVersion[];
  pressings: VinylPressing[];
}

export interface WantedAlbum {
  masterId: number;
  year?: number;
}

export function pressingsFileName(masterId: number): string {
  return `master-${masterId}.json`;
}

export function pressingsDue(
  album: WantedAlbum,
  file: PressingsFile | undefined,
  now = Date.now(),
): boolean {
  if (!file || file.next !== null) return true;
  const recent = (album.year ?? 0) >= new Date(now).getUTCFullYear() - 1;
  return now - Date.parse(file.cachedAt) > (recent ? RECENT_RECHECK_MS : RECHECK_MS);
}

/** Albums partway through first, then never-saved ones, then the oldest saved. */
export function pressingsOrder(
  albums: WantedAlbum[],
  files: Map<number, PressingsFile>,
  now = Date.now(),
): WantedAlbum[] {
  const rank = (album: WantedAlbum) => {
    const file = files.get(album.masterId);
    if (!file) return Number.MIN_SAFE_INTEGER + 1;
    if (file.next !== null) return Number.MIN_SAFE_INTEGER;
    return Date.parse(file.cachedAt);
  };
  return albums
    .filter((album) => pressingsDue(album, files.get(album.masterId), now))
    .sort((left, right) => rank(left) - rank(right));
}

/**
 * Lists the album's official vinyl pressings, then fills in details one pressing at a time
 * until `timeLeft` says stop. `save` is called as progress is made.
 */
export async function refreshPressings(
  masterId: number,
  existing: PressingsFile | undefined,
  get: Get,
  timeLeft: () => boolean,
  save: (file: PressingsFile) => Promise<void>,
  now = new Date(),
): Promise<PressingsFile> {
  let file = existing && existing.next !== null ? existing : undefined;
  if (!file) {
    const versions: DiscogsMasterVersion[] = [];
    for (let page = 1; ; page++) {
      const data = await get<DiscogsMasterVersionsPage>(`/masters/${masterId}/versions`, {
        format: 'Vinyl',
        sort: 'released',
        sort_order: 'asc',
        per_page: '100',
        page: String(page),
      });
      versions.push(...data.versions.filter(isOfficialVersion));
      if (page >= data.pagination.pages) break;
    }
    // A recheck keeps details already known, so only new pressings cost a request.
    const known = new Map(
      existing?.pressings.filter((pressing) => pressing.detailed).map((p) => [p.releaseId, p]),
    );
    file = {
      cachedAt: now.toISOString(),
      next: 0,
      versions,
      pressings: versions.map((version) => known.get(version.id) ?? toPressing(version)),
    };
  }

  while (file.next !== null && file.next < file.versions.length && timeLeft()) {
    const index = file.next;
    if (!file.pressings[index].detailed) {
      try {
        const detail = await get<DiscogsReleaseDetail>(`/releases/${file.versions[index].id}`);
        file.pressings[index] = toPressing(file.versions[index], detail);
      } catch (error) {
        // A pressing Discogs can't return keeps its basic details rather than blocking the album.
        console.warn(`Pressing ${file.versions[index].id} keeps basic details:`, error);
      }
    }
    file.next = index + 1;
    if (file.next % 25 === 0) await save(file);
  }
  if (file.next !== null && file.next >= file.versions.length) {
    file = { ...file, next: null, versions: [], pressings: sortPressings(file.pressings) };
  }
  await save(file);
  return file;
}
