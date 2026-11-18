import { get, put } from '@vercel/blob';
import { readBlobText, readCatalog, type CatalogRelease } from './catalog.repository.js';

const DISCOGS_API_URL = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'VinylArchive/1.0';
const CACHE_PREFIX = 'vinyl-archive/missing-albums';
const SUMMARY_PATHNAME = `${CACHE_PREFIX}/summary.json`;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Stay well inside the shortest Vercel function limit; progress is saved and resumed.
const TIME_BUDGET_MS = 40_000;
// Extra time an in-flight Discogs request may use past the budget before giving up.
const REQUEST_GRACE_MS = 8_000;
const RATE_LIMIT_FLOOR = 5;
const EXCLUDED_DESCRIPTIONS = ['Unofficial Release', 'Test Pressing', 'Promo'];
const ALBUM_DESCRIPTIONS = ['Album', 'Compilation'];
const NON_ALBUM_DESCRIPTIONS = ['Single', 'Maxi-Single', 'EP', 'Mini-Album'];
const VARIOUS_ARTISTS_ID = 194;
const REFRESH_LOCK_PATHNAME = `${CACHE_PREFIX}/refresh-lock.json`;
const REFRESH_LOCK_MS = 120_000;
const MAX_REFRESH_HOPS = 500;
const HANDOFF_WAIT_MS = 3_000;

type VercelRequest = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
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
  /** Collection artist credits (see catalogKey) that share this discography. */
  catalogKeys: string[];
  /** Results from the previous check, still shown while a refresh is in progress. */
  previousAlbums?: ArtistMaster[];
}

export interface SummaryEntry {
  cachedAt: string;
  complete: boolean;
  albums: ArtistMaster[] | null;
}

export interface MissingAlbumsSummary {
  updatedAt: string;
  artists: Record<string, SummaryEntry>;
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

class DiscogsRateLimitError extends Error {}

async function discogsGet<T>(
  path: string,
  token: string,
  deadline: number,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, DISCOGS_API_URL);
  const hardStop = deadline + REQUEST_GRACE_MS;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.max(1_000, hardStop - Date.now())),
      headers: {
        Accept: 'application/json',
        'User-Agent': DISCOGS_USER_AGENT,
        Authorization: `Discogs token=${token}`,
      },
    });
    if (response.status === 429) {
      const wait = (Number(response.headers.get('retry-after')) || 10) * 1000;
      if (Date.now() + wait > hardStop)
        throw new Error('Discogs rate limit outlasted the time budget');
      await sleep(wait);
      continue;
    }
    if (!response.ok) throw new Error(`Discogs request failed with ${response.status}`);
    // Discogs refills roughly one request per second; slow down before hitting the limit.
    const remaining = Number(response.headers.get('x-discogs-ratelimit-remaining') ?? 60);
    if (remaining < RATE_LIMIT_FLOOR) await sleep(1100);
    return (await response.json()) as T;
  }
  throw new DiscogsRateLimitError('Discogs rate limit was not released in time');
}

async function readCache<T extends { cachedAt: string }>(pathname: string): Promise<T | null> {
  try {
    const blob = await get(pathname, { access: 'private', useCache: false });
    if (!blob) return null;
    return JSON.parse(await readBlobText(blob.stream)) as T;
  } catch {
    return null;
  }
}

function isFresh(document: { cachedAt: string }): boolean {
  return Date.now() - Date.parse(document.cachedAt) <= CACHE_TTL_MS;
}

export function catalogKey(artists: string[]): string {
  return artists.join('|');
}

export function summaryEntry(document: ArtistAlbumsDocument): SummaryEntry {
  return {
    cachedAt: document.cachedAt,
    complete: document.complete,
    albums: document.complete ? document.albums : (document.previousAlbums ?? null),
  };
}

async function readSummary(): Promise<MissingAlbumsSummary> {
  return (
    (await readCache<MissingAlbumsSummary>(SUMMARY_PATHNAME)) ?? {
      updatedAt: new Date(0).toISOString(),
      artists: {},
    }
  );
}

async function recordInSummary(document: ArtistAlbumsDocument): Promise<void> {
  if (document.catalogKeys.length === 0) return;
  const summary = await readSummary();
  for (const key of document.catalogKeys) summary.artists[key] = summaryEntry(document);
  summary.updatedAt = new Date().toISOString();
  await writeCache(SUMMARY_PATHNAME, summary);
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
  key?: string,
): Promise<ArtistAlbumsDocument> {
  const release = await discogsGet<DiscogsReleaseDetail>(`/releases/${releaseId}`, token, deadline);
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
    catalogKeys: [],
  };
  if (artist.id === VARIOUS_ARTISTS_ID) return { ...emptyDocument, complete: true };

  const pathname = `${CACHE_PREFIX}/artist-${artists.map((credit) => credit.id).join('-')}.json`;
  const cached = await readCache<ArtistAlbumsDocument>(pathname);
  let document: ArtistAlbumsDocument;
  if (cached && (!cached.complete || isFresh(cached))) {
    document = { ...cached, catalogKeys: cached.catalogKeys ?? [] };
  } else if (cached) {
    document = {
      ...emptyDocument,
      catalogKeys: cached.catalogKeys ?? [],
      previousAlbums: cached.albums,
    };
  } else {
    document = emptyDocument;
  }

  const isNewKey = key !== undefined && !document.catalogKeys.includes(key);
  if (isNewKey) document.catalogKeys.push(key);
  if (document.complete) {
    if (isNewKey) {
      await writeCache(pathname, document);
      await recordInSummary(document);
    }
    return document;
  }

  let listingError: unknown;
  while (
    (document.totalPages === undefined || document.pagesFetched < document.totalPages) &&
    Date.now() < deadline
  ) {
    let data: DiscogsArtistReleasesPage;
    try {
      data = await discogsGet<DiscogsArtistReleasesPage>(
        `/artists/${artist.id}/releases`,
        token,
        deadline,
        {
          sort: 'year',
          sort_order: 'asc',
          per_page: '100',
          page: String(document.pagesFetched + 1),
        },
      );
    } catch (error) {
      listingError = error;
      break;
    }
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
    try {
      const data = await discogsGet<DiscogsMasterVersionsPage>(
        `/masters/${master.masterId}/versions`,
        token,
        deadline,
        { format: 'Vinyl', per_page: '100' },
      );
      if (isVinylAlbum(data.versions)) document.albums.push(master);
    } catch (error) {
      if (error instanceof DiscogsRateLimitError) break;
      // A master Discogs can't return is skipped rather than blocking the rest of the artist.
    }
    document.checked++;
  }

  document.complete = listed && document.checked >= document.masters.length;
  await writeCache(pathname, document);
  await recordInSummary(document);
  if (listingError && !(listingError instanceof DiscogsRateLimitError)) throw listingError;
  return document;
}

async function loadPressings(
  masterId: number,
  token: string,
  deadline: number,
): Promise<PressingsDocument> {
  const pathname = `${CACHE_PREFIX}/master-${masterId}.json`;
  const cached = await readCache<PressingsDocument>(pathname);
  if (cached?.complete && isFresh(cached)) return cached;

  const versions: DiscogsMasterVersion[] = [];
  for (let page = 1; ; page++) {
    const data = await discogsGet<DiscogsMasterVersionsPage>(
      `/masters/${masterId}/versions`,
      token,
      deadline,
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
      const detail = await discogsGet<DiscogsReleaseDetail>(
        `/releases/${version.id}`,
        token,
        deadline,
      );
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

/** One entry per artist credit in the collection, with a release to resolve it from. */
export function collectionArtists(releases: CatalogRelease[]): Map<string, number> {
  const artists = new Map<string, number>();
  for (const release of releases) {
    const credits = release.basicInfo.artists;
    if (credits.length === 0 || credits[0].startsWith('Various')) continue;
    const key = catalogKey(credits);
    if (!artists.has(key)) artists.set(key, release.id);
  }
  return artists;
}

/**
 * Artists never checked come first, then ones mid-check, then the oldest results, so a huge
 * discography that takes many runs doesn't hold up the rest of the collection.
 */
export function refreshOrder(
  artists: Map<string, number>,
  summary: MissingAlbumsSummary,
  now = Date.now(),
): Array<[string, number]> {
  const due = [...artists].filter(([key]) => {
    const entry = summary.artists[key];
    return !entry || !entry.complete || now - Date.parse(entry.cachedAt) > CACHE_TTL_MS;
  });
  const rank = (key: string) => {
    const entry = summary.artists[key];
    if (!entry) return -Infinity;
    return entry.complete ? Date.parse(entry.cachedAt) : Number.MIN_SAFE_INTEGER;
  };
  return due.sort(([left], [right]) => rank(left) - rank(right));
}

async function refreshCollection(
  token: string,
  deadline: number,
): Promise<{ processed: number; succeeded: number; remaining: number; pending: number }> {
  const [catalog, summary] = await Promise.all([readCatalog(), readSummary()]);
  const due = refreshOrder(collectionArtists(catalog.releases), summary);
  let processed = 0;
  let succeeded = 0;
  let unfinished = 0;
  for (const [key, releaseId] of due) {
    if (Date.now() >= deadline) break;
    try {
      const document = await loadArtistAlbums(releaseId, token, deadline, key);
      succeeded++;
      if (!document.complete) unfinished++;
    } catch {
      // Skip artists Discogs can't resolve; they are retried on the next refresh.
      unfinished++;
    }
    processed++;
  }
  const remaining = due.length - processed;
  return { processed, succeeded, remaining, pending: remaining + unfinished };
}

interface RefreshLock {
  cachedAt: string;
  runId: string;
  expiresAt: number;
}

/** Only one refresh chain runs at a time, so runs don't overwrite each other's summary writes. */
async function claimRefreshLock(runId: string | undefined): Promise<string | null> {
  const lock = await readCache<RefreshLock>(REFRESH_LOCK_PATHNAME);
  if (lock && lock.expiresAt > Date.now() && lock.runId !== runId) return null;
  const claimed = runId ?? crypto.randomUUID();
  await writeRefreshLock(claimed, Date.now() + REFRESH_LOCK_MS);
  return claimed;
}

async function writeRefreshLock(runId: string, expiresAt: number): Promise<void> {
  await writeCache(REFRESH_LOCK_PATHNAME, {
    cachedAt: new Date().toISOString(),
    runId,
    expiresAt,
  } satisfies RefreshLock);
}

/** Starts the next refresh run; it keeps running after this request stops waiting for it. */
async function handOff(req: VercelRequest, runId: string, hop: number): Promise<void> {
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (!host) return;
  const url = `https://${host}/api/missing-albums?refresh=1&run=${runId}&hop=${hop}`;
  try {
    await fetch(url, { signal: AbortSignal.timeout(HANDOFF_WAIT_MS) });
  } catch {
    // The timeout is expected: the next run is still working.
  }
}

function positiveInteger(value: string | string[] | undefined): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function catalogKeyFor(releaseId: number): Promise<string | undefined> {
  const catalog = await readCatalog();
  const release = catalog.releases.find((candidate) => candidate.id === releaseId);
  return release ? catalogKey(release.basicInfo.artists) : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (req.query.summary !== undefined) {
    try {
      const summary = await readSummary();
      res.setHeader('Cache-Control', 'no-store').status(200).json(summary);
    } catch {
      res.status(500).json({ error: 'Missing albums summary could not be read' });
    }
    return;
  }

  const token = process.env.DISCOGS_TOKEN?.trim();
  if (!token) {
    res.status(503).json({ error: 'Discogs server configuration is unavailable' });
    return;
  }

  const deadline = Date.now() + TIME_BUDGET_MS;
  if (req.query.refresh !== undefined) {
    try {
      const requestedRun = Array.isArray(req.query.run) ? req.query.run[0] : req.query.run;
      const runId = await claimRefreshLock(requestedRun);
      if (!runId) {
        res.status(200).json({ skipped: 'A refresh is already running' });
        return;
      }
      const hop = positiveInteger(req.query.hop) ?? 1;
      const result = await refreshCollection(token, deadline);
      // Stop when everything is done, or when the only artists left keep failing.
      const madeProgress = result.succeeded > 0 || result.remaining > 0;
      const continues = result.pending > 0 && madeProgress && hop < MAX_REFRESH_HOPS;
      if (continues) {
        await handOff(req, runId, hop + 1);
      } else {
        await writeRefreshLock(runId, 0);
      }
      res.status(200).json({ ...result, continues, hop });
    } catch {
      res.status(502).json({ error: 'Missing albums refresh failed' });
    }
    return;
  }

  const releaseId = positiveInteger(req.query.releaseId);
  const masterId = positiveInteger(req.query.masterId);
  if (!releaseId && !masterId) {
    res.status(400).json({ error: 'A releaseId or masterId is required' });
    return;
  }

  try {
    if (masterId) {
      const { pressings, complete } = await loadPressings(masterId, token, deadline);
      res.status(200).json({ pressings, complete });
    } else {
      const key = await catalogKeyFor(releaseId!);
      const document = await loadArtistAlbums(releaseId!, token, deadline, key);
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
