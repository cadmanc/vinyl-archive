import { get, put } from '@vercel/blob';
import { readBlobText } from './catalog.repository.js';

const DISCOGS_API_URL = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'VinylArchive/1.0';
const CACHE_PREFIX = 'vinyl-archive/missing-albums';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Stay well inside the shortest Vercel function limit; progress is saved and resumed.
const TIME_BUDGET_MS = 45_000;
const RATE_LIMIT_FLOOR = 5;
const EXCLUDED_DESCRIPTIONS = ['Unofficial Release', 'Test Pressing', 'Promo'];
const ALBUM_DESCRIPTIONS = ['Album', 'Compilation'];
const NON_ALBUM_DESCRIPTIONS = ['Single', 'Maxi-Single', 'EP', 'Mini-Album'];
const VARIOUS_ARTISTS_ID = 194;

type VercelRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

interface DiscogsArtistReleasesPage {
  pagination: { pages: number };
  releases: Array<{
    id: number;
    type: string;
    role: string;
    title: string;
    artist?: string;
    year?: number;
  }>;
}

interface DiscogsMasterVersion {
  id: number;
  format?: string;
  released?: string;
  country?: string;
  label?: string;
  catno?: string;
}

interface DiscogsMasterVersionsPage {
  pagination: { pages: number };
  versions: DiscogsMasterVersion[];
}

interface DiscogsReleaseDetail {
  artists?: Array<{ id: number; name: string }>;
  formats?: Array<{ name: string; qty?: string; descriptions?: string[]; text?: string }>;
}

export interface ArtistMaster {
  masterId: number;
  title: string;
  year?: number;
}

export interface ArtistAlbumsDocument {
  cachedAt: string;
  artist: { id: number; name: string };
  masters: ArtistMaster[];
  pagesFetched: number;
  totalPages?: number;
  checked: number;
  albums: ArtistMaster[];
  complete: boolean;
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
  detailed: boolean;
}

interface PressingsDocument {
  cachedAt: string;
  pressings: VinylPressing[];
  complete: boolean;
}

export function formatDescriptions(format: string | undefined): string[] {
  return (format ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isOfficialVersion(version: DiscogsMasterVersion): boolean {
  const descriptions = formatDescriptions(version.format);
  return !descriptions.some((description) => EXCLUDED_DESCRIPTIONS.includes(description));
}

export function isAlbumVersion(version: DiscogsMasterVersion): boolean {
  const descriptions = formatDescriptions(version.format);
  return (
    descriptions.some((description) => ALBUM_DESCRIPTIONS.includes(description)) &&
    !descriptions.some((description) => NON_ALBUM_DESCRIPTIONS.includes(description))
  );
}

/** A master counts as a full album only if it has an official vinyl album pressing. */
export function isVinylAlbum(vinylVersions: DiscogsMasterVersion[]): boolean {
  return vinylVersions.some((version) => isOfficialVersion(version) && isAlbumVersion(version));
}

export function parseYear(released: string | undefined): number | undefined {
  const year = Number.parseInt(released ?? '', 10);
  return Number.isInteger(year) && year > 0 ? year : undefined;
}

export function toPressing(
  version: DiscogsMasterVersion,
  detail?: DiscogsReleaseDetail,
): VinylPressing {
  const vinylFormats = detail?.formats?.filter((format) => format.name === 'Vinyl') ?? [];
  const discs = vinylFormats.reduce((total, format) => total + (Number(format.qty) || 0), 0);
  const descriptions = vinylFormats.length
    ? [...new Set(vinylFormats.flatMap((format) => format.descriptions ?? []))]
    : formatDescriptions(version.format);
  const details = vinylFormats
    .map((format) => format.text?.trim())
    .filter(Boolean)
    .join(', ');
  return {
    releaseId: version.id,
    year: parseYear(version.released),
    country: version.country || undefined,
    label: version.label || undefined,
    catno: version.catno || undefined,
    discs: discs || undefined,
    descriptions,
    details: details || undefined,
    detailed: detail !== undefined,
  };
}

export function sortPressings(pressings: VinylPressing[]): VinylPressing[] {
  return [...pressings].sort(
    (left, right) =>
      (left.year ?? Infinity) - (right.year ?? Infinity) || left.releaseId - right.releaseId,
  );
}

export function normalizeArtistName(name: string): string {
  return name
    .replace(/\s+\(\d+\)$/, '')
    .trim()
    .toLocaleLowerCase();
}

/** For a collaboration, keep only titles credited to every collaborating artist. */
export function creditsAllArtists(credit: string | undefined, partners: string[]): boolean {
  const normalizedCredit = (credit ?? '').toLocaleLowerCase();
  return partners.every((partner) => normalizedCredit.includes(normalizeArtistName(partner)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function discogsGet<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, DISCOGS_API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': DISCOGS_USER_AGENT,
        Authorization: `Discogs token=${token}`,
      },
    });
    if (response.status === 429) {
      await sleep((Number(response.headers.get('retry-after')) || 10) * 1000);
      continue;
    }
    if (!response.ok) throw new Error(`Discogs request failed with ${response.status}`);
    // Discogs refills roughly one request per second; slow down before hitting the limit.
    const remaining = Number(response.headers.get('x-discogs-ratelimit-remaining') ?? 60);
    if (remaining < RATE_LIMIT_FLOOR) await sleep(1100);
    return (await response.json()) as T;
  }
  throw new Error('Discogs rate limit was not released in time');
}

async function readCache<T extends { cachedAt: string }>(pathname: string): Promise<T | null> {
  try {
    const blob = await get(pathname, { access: 'private', useCache: false });
    if (!blob) return null;
    const document = JSON.parse(await readBlobText(blob.stream)) as T;
    if (Date.now() - Date.parse(document.cachedAt) > CACHE_TTL_MS) return null;
    return document;
  } catch {
    return null;
  }
}

async function writeCache(pathname: string, document: unknown): Promise<void> {
  await put(pathname, JSON.stringify(document), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

async function loadArtistAlbums(
  releaseId: number,
  token: string,
  deadline: number,
): Promise<ArtistAlbumsDocument> {
  const release = await discogsGet<DiscogsReleaseDetail>(`/releases/${releaseId}`, token);
  const artists = release.artists ?? [];
  const artist = artists[0];
  if (!artist) throw new Error('Release has no artist');
  const partners = artists.slice(1).map((partner) => partner.name);

  const emptyDocument: ArtistAlbumsDocument = {
    cachedAt: new Date().toISOString(),
    artist: { id: artist.id, name: artist.name },
    masters: [],
    pagesFetched: 0,
    checked: 0,
    albums: [],
    complete: false,
  };
  if (artist.id === VARIOUS_ARTISTS_ID) return { ...emptyDocument, complete: true };

  const pathname = `${CACHE_PREFIX}/artist-${artists.map((credit) => credit.id).join('-')}.json`;
  const document = (await readCache<ArtistAlbumsDocument>(pathname)) ?? emptyDocument;
  if (document.complete) return document;

  while (
    (document.totalPages === undefined || document.pagesFetched < document.totalPages) &&
    Date.now() < deadline
  ) {
    const data = await discogsGet<DiscogsArtistReleasesPage>(
      `/artists/${artist.id}/releases`,
      token,
      {
        sort: 'year',
        sort_order: 'asc',
        per_page: '100',
        page: String(document.pagesFetched + 1),
      },
    );
    document.masters.push(
      ...data.releases
        .filter(
          (item) =>
            item.type === 'master' &&
            item.role === 'Main' &&
            creditsAllArtists(item.artist, partners),
        )
        .map((item) => ({ masterId: item.id, title: item.title, year: item.year || undefined })),
    );
    document.pagesFetched++;
    document.totalPages = data.pagination.pages;
  }
  const listed = document.totalPages !== undefined && document.pagesFetched >= document.totalPages;

  while (listed && document.checked < document.masters.length && Date.now() < deadline) {
    const master = document.masters[document.checked];
    const data = await discogsGet<DiscogsMasterVersionsPage>(
      `/masters/${master.masterId}/versions`,
      token,
      { format: 'Vinyl', per_page: '100' },
    );
    if (isVinylAlbum(data.versions)) document.albums.push(master);
    document.checked++;
  }

  document.complete = listed && document.checked >= document.masters.length;
  await writeCache(pathname, document);
  return document;
}

async function loadPressings(
  masterId: number,
  token: string,
  deadline: number,
): Promise<PressingsDocument> {
  const pathname = `${CACHE_PREFIX}/master-${masterId}.json`;
  const cached = await readCache<PressingsDocument>(pathname);
  if (cached?.complete) return cached;

  const versions: DiscogsMasterVersion[] = [];
  for (let page = 1; ; page++) {
    const data = await discogsGet<DiscogsMasterVersionsPage>(
      `/masters/${masterId}/versions`,
      token,
      {
        format: 'Vinyl',
        sort: 'released',
        sort_order: 'asc',
        per_page: '100',
        page: String(page),
      },
    );
    versions.push(...data.versions.filter(isOfficialVersion));
    if (page >= data.pagination.pages) break;
  }

  const known = new Map(cached?.pressings.map((pressing) => [pressing.releaseId, pressing]));
  const pressings: VinylPressing[] = [];
  let complete = true;
  for (const version of versions) {
    const existing = known.get(version.id);
    if (existing?.detailed) {
      pressings.push(existing);
    } else if (Date.now() < deadline) {
      const detail = await discogsGet<DiscogsReleaseDetail>(`/releases/${version.id}`, token);
      pressings.push(toPressing(version, detail));
    } else {
      complete = false;
      pressings.push(toPressing(version));
    }
  }

  const document: PressingsDocument = {
    cachedAt: new Date().toISOString(),
    pressings: sortPressings(pressings),
    complete,
  };
  await writeCache(pathname, document);
  return document;
}

function positiveInteger(value: string | string[] | undefined): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = process.env.DISCOGS_TOKEN?.trim();
  if (!token) {
    res.status(503).json({ error: 'Discogs server configuration is unavailable' });
    return;
  }

  const releaseId = positiveInteger(req.query.releaseId);
  const masterId = positiveInteger(req.query.masterId);
  if (!releaseId && !masterId) {
    res.status(400).json({ error: 'A releaseId or masterId is required' });
    return;
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  try {
    if (masterId) {
      const { pressings, complete } = await loadPressings(masterId, token, deadline);
      res.status(200).json({ pressings, complete });
    } else {
      const document = await loadArtistAlbums(releaseId!, token, deadline);
      res.status(200).json({
        artist: document.artist,
        albums: document.albums,
        complete: document.complete,
        checked: document.checked,
        total: document.masters.length,
      });
    }
  } catch {
    res.status(502).json({ error: 'Discogs lookup failed' });
  }
}
