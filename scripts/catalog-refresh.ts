/**
 * Builds catalog.json: every copy in the Discogs collection with the same details the site
 * used to look up in each browser (tracklist, runtime, label, format, original year).
 * Details already saved are reused, so only newly added records cost Discogs requests.
 */
import {
  formatRelease,
  type CatalogRelease,
  type DiscogsCollectionItem,
} from '../api/_catalog-format.js';
import { conciseDiscogsFormat } from '../src/app/features/discogs/discogs-api.model.js';
import type { ReleaseTrack } from '../src/app/shared/models/release.model.js';

export interface CatalogFile {
  schemaVersion: 1;
  updatedAt: string;
  releases: CatalogRelease[];
}

interface ReleaseDetails {
  year?: number;
  master_id?: number;
  labels?: Array<{ name?: string; catno?: string }>;
  formats?: Array<{ name?: string; qty?: string; descriptions?: string[] }>;
  tracklist?: Array<{ position?: string; title?: string; duration?: string; type?: string }>;
}

interface MusicBrainzSearch {
  'release-groups'?: Array<{
    title: string;
    score?: number;
    'first-release-date'?: string;
    'artist-credit'?: Array<{ name?: string; artist?: { name?: string } }>;
  }>;
}

export type Get = <T>(pathname: string, params?: Record<string, string>) => Promise<T>;
export type MusicBrainzGet = (query: string) => Promise<MusicBrainzSearch>;

const DETAIL_FIELDS = [
  'masterId',
  'year',
  'label',
  'catalogNumber',
  'format',
  'tracklist',
  'detailsFetched',
  'trackCount',
  'totalRuntimeSeconds',
] as const;

function durationToSeconds(duration?: string): number | undefined {
  if (!duration) return undefined;
  const parts = duration.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return undefined;
}

export function parseYear(value?: string | number): number | undefined {
  const match = String(value ?? '').match(/\b(18|19|20)\d{2}\b/);
  if (!match) return undefined;
  const year = Number(match[0]);
  return year >= 1800 && year <= new Date().getFullYear() ? year : undefined;
}

export function normalizeMatchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+\(\d+\)$/g, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/^(the|an|a)\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The same fields the site fills in from a Discogs release lookup. */
export function releaseDetails(details: ReleaseDetails): Partial<CatalogRelease['basicInfo']> {
  const label = details.labels?.[0]?.name;
  const catalogNumber = details.labels?.[0]?.catno;
  const format = details.formats
    ?.map((item) => conciseDiscogsFormat(item.name, item.descriptions, item.qty))
    .filter(Boolean)
    .join(', ');
  const tracklist: ReleaseTrack[] = (details.tracklist ?? []).map((track) => ({
    position: track.position ?? '',
    title: track.title ?? '',
    ...(track.duration ? { duration: track.duration } : {}),
    ...(track.type ? { type: track.type } : {}),
  }));
  const musicalTracks = tracklist.filter(
    (track) => track.type !== 'heading' && track.type !== 'index',
  );
  const durations = musicalTracks.map((track) => durationToSeconds(track.duration));
  return {
    ...(details.master_id ? { masterId: details.master_id } : {}),
    ...(label ? { label } : {}),
    ...(catalogNumber ? { catalogNumber } : {}),
    ...(format ? { format } : {}),
    ...(details.year ? { year: details.year } : {}),
    detailsFetched: true,
    trackCount: musicalTracks.length,
    tracklist,
    ...(musicalTracks.length > 0 &&
    durations.every((duration): duration is number => duration != null)
      ? { totalRuntimeSeconds: durations.reduce((sum, value) => sum + value, 0) }
      : {}),
  };
}

/** Saved details for a release, from the previous catalog. */
function savedDetails(previous: CatalogRelease | undefined): Partial<CatalogRelease['basicInfo']> {
  if (!previous) return {};
  const info = previous.basicInfo;
  const saved: Partial<CatalogRelease['basicInfo']> = {};
  if (info.detailsFetched) {
    for (const field of DETAIL_FIELDS) {
      if (info[field] !== undefined) Object.assign(saved, { [field]: info[field] });
    }
  }
  if (info.originalYear != null) saved.originalYear = info.originalYear;
  if (info.originalYearUnknown) saved.originalYearUnknown = true;
  return saved;
}

/** A fixed key order, so an unchanged catalog is written byte for byte the same. */
function sortedKeys<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as T;
}

export function needsLookup(release: CatalogRelease): boolean {
  const info = release.basicInfo;
  return !info.detailsFetched || (info.originalYear == null && !info.originalYearUnknown);
}

/** Matches the site's original year order: Discogs master, its earliest version, MusicBrainz. */
async function originalYear(
  release: CatalogRelease,
  get: Get,
  musicBrainz: MusicBrainzGet,
): Promise<number | undefined> {
  const masterId = release.basicInfo.masterId;
  if (masterId) {
    const master = await get<{ year?: number }>(`/masters/${masterId}`);
    if (master.year) return master.year;
    const versions = await get<{ versions: Array<{ released?: string }> }>(
      `/masters/${masterId}/versions`,
      { per_page: '100' },
    );
    const years = versions.versions
      .map((version) => parseYear(version.released))
      .filter((year): year is number => year != null);
    if (years.length) return Math.min(...years);
  }
  const artists = release.basicInfo.artists.map(normalizeMatchText);
  const title = normalizeMatchText(release.basicInfo.title);
  const result = await musicBrainz(`artist:"${artists.join(' ')}" AND releasegroup:"${title}"`);
  const match = (result['release-groups'] ?? [])
    .filter(
      (group) =>
        normalizeMatchText(group.title) === title &&
        (group['artist-credit'] ?? []).some((credit) =>
          artists.includes(normalizeMatchText(credit.name ?? credit.artist?.name ?? '')),
        ),
    )
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];
  return parseYear(match?.['first-release-date']);
}

/**
 * The catalog for the current collection. Records without saved details are looked up
 * until `timeLeft` says stop; the rest are listed with basic details and finished next run.
 */
export async function buildCatalog(
  items: DiscogsCollectionItem[],
  previous: CatalogFile | null,
  get: Get,
  musicBrainz: MusicBrainzGet,
  timeLeft: () => boolean,
  now = new Date(),
): Promise<CatalogFile> {
  const saved = new Map(previous?.releases.map((release) => [release.id, release]));
  const looked = new Map<number, Partial<CatalogRelease['basicInfo']>>();
  const releases: CatalogRelease[] = [];
  for (const item of items) {
    const release = formatRelease(item);
    Object.assign(release.basicInfo, savedDetails(saved.get(release.id)), looked.get(release.id));
    if (needsLookup(release) && timeLeft() && !looked.has(release.id)) {
      try {
        if (!release.basicInfo.detailsFetched) {
          Object.assign(
            release.basicInfo,
            releaseDetails(await get<ReleaseDetails>(`/releases/${release.id}`)),
          );
        }
        const year = await originalYear(release, get, musicBrainz);
        if (year != null) release.basicInfo.originalYear = year;
        else release.basicInfo.originalYearUnknown = true;
      } catch (error) {
        console.warn(`Details for release ${release.id} are left for the next run:`, error);
      }
      looked.set(release.id, savedDetails(release));
    }
    releases.push({ ...release, basicInfo: sortedKeys(release.basicInfo) });
  }
  const unchanged =
    previous !== null && JSON.stringify(previous.releases) === JSON.stringify(releases);
  return {
    schemaVersion: 1,
    updatedAt: unchanged ? previous.updatedAt : now.toISOString(),
    releases,
  };
}
