const DISCOGS_API_URL = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'VinylArchive/1.0';
// Each request stays well inside the function limit; the page asks again for the rest.
const TIME_BUDGET_MS = 40_000;
// Extra time an in-flight Discogs request may use past the budget before giving up.
const REQUEST_GRACE_MS = 8_000;
const RATE_LIMIT_FLOOR = 5;
const EXCLUDED_DESCRIPTIONS = ['Unofficial Release', 'Test Pressing', 'Promo'];
const ALBUM_DESCRIPTIONS = ['Album', 'Compilation'];
const NON_ALBUM_DESCRIPTIONS = ['Single', 'Maxi-Single', 'EP', 'Mini-Album'];
const EP_DESCRIPTIONS = ['EP', 'Mini-Album'];

export type VinylKind = 'album' | 'ep' | 'compilation';
// Pressing lists rarely change; the CDN serves repeat requests without calling Discogs.
const PRESSINGS_CACHE_CONTROL = 'public, s-maxage=604800, stale-while-revalidate=86400';

type VercelRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

export interface DiscogsArtistReleasesPage {
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

export interface DiscogsMasterVersion {
  id: number;
  format?: string;
  released?: string;
  country?: string;
  label?: string;
  catno?: string;
}

export interface DiscogsMasterVersionsPage {
  pagination: { pages: number };
  versions: DiscogsMasterVersion[];
}

export interface DiscogsReleaseDetail {
  formats?: Array<{ name: string; qty?: string; descriptions?: string[]; text?: string }>;
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

/**
 * Official vinyl album, compilation, or EP — the titles we keep in the missing list.
 * Compilations and EPs are auto-hidden until the owner unhides them.
 */
export function vinylReleaseKind(vinylVersions: DiscogsMasterVersion[]): VinylKind | false {
  const official = vinylVersions.filter(isOfficialVersion);
  const descriptions = (version: DiscogsMasterVersion) => formatDescriptions(version.format);
  const studioAlbum = official.some((version) => {
    const parts = descriptions(version);
    return (
      parts.includes('Album') &&
      !parts.includes('Compilation') &&
      !parts.some((part) => NON_ALBUM_DESCRIPTIONS.includes(part))
    );
  });
  if (studioAlbum) return 'album';
  const compilation = official.some((version) => {
    const parts = descriptions(version);
    return (
      parts.includes('Compilation') && !parts.some((part) => NON_ALBUM_DESCRIPTIONS.includes(part))
    );
  });
  if (compilation) return 'compilation';
  const ep = official.some((version) => {
    const parts = descriptions(version);
    return (
      parts.some((part) => EP_DESCRIPTIONS.includes(part)) &&
      !parts.includes('Single') &&
      !parts.includes('Maxi-Single')
    );
  });
  return ep ? 'ep' : false;
}

/** A master counts when it has an official vinyl album, compilation, or EP pressing. */
export function isVinylAlbum(vinylVersions: DiscogsMasterVersion[]): boolean {
  return vinylReleaseKind(vinylVersions) !== false;
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

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscogsRateLimitError extends Error {}

export class DiscogsNotFoundError extends Error {}

export async function discogsGet<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
  hardStop = Infinity,
): Promise<T> {
  const url = new URL(path, DISCOGS_API_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; attempt < 6; attempt++) {
    const timeout = Number.isFinite(hardStop) ? Math.max(1_000, hardStop - Date.now()) : 30_000;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: {
        Accept: 'application/json',
        'User-Agent': DISCOGS_USER_AGENT,
        Authorization: `Discogs token=${token}`,
      },
    });
    if (response.status === 429) {
      const wait = (Number(response.headers.get('retry-after')) || 10) * 1000;
      if (Date.now() + wait > hardStop) {
        throw new DiscogsRateLimitError('Discogs rate limit outlasted the time budget');
      }
      await sleep(wait);
      continue;
    }
    if (response.status === 404) throw new DiscogsNotFoundError(`Discogs has no ${path}`);
    if (!response.ok) throw new Error(`Discogs request failed with ${response.status}`);
    // Discogs refills roughly one request per second; slow down before hitting the limit.
    const remaining = Number(response.headers.get('x-discogs-ratelimit-remaining') ?? 60);
    if (remaining < RATE_LIMIT_FLOOR) await sleep(1100);
    return (await response.json()) as T;
  }
  throw new DiscogsRateLimitError('Discogs rate limit was not released in time');
}

/**
 * Official vinyl pressings of a master. Colour and weight need one request per pressing,
 * so details are fetched in batches: `from` is where this batch starts, and `next` tells
 * the caller where to continue, or is null once every pressing has its details.
 */
async function loadPressings(
  masterId: number,
  from: number,
  token: string,
  deadline: number,
): Promise<{ pressings: VinylPressing[]; next: number | null }> {
  const hardStop = deadline + REQUEST_GRACE_MS;
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
      hardStop,
    );
    versions.push(...data.versions.filter(isOfficialVersion));
    if (page >= data.pagination.pages) break;
  }

  const pressings: VinylPressing[] = [];
  let next: number | null = null;
  for (const [index, version] of versions.entries()) {
    if (index < from || next !== null) {
      pressings.push(toPressing(version));
      continue;
    }
    try {
      if (Date.now() >= deadline) throw new DiscogsRateLimitError('Time budget used');
      const detail = await discogsGet<DiscogsReleaseDetail>(
        `/releases/${version.id}`,
        token,
        {},
        hardStop,
      );
      pressings.push(toPressing(version, detail));
    } catch (error) {
      if (!(error instanceof DiscogsRateLimitError)) throw error;
      next = index;
      pressings.push(toPressing(version));
    }
  }
  return { pressings, next };
}

function nonNegativeInteger(value: string | string[] | undefined): number | null {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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

  const masterId = nonNegativeInteger(req.query.masterId);
  const from = nonNegativeInteger(req.query.from) ?? 0;
  if (!masterId) {
    res.status(400).json({ error: 'A masterId is required' });
    return;
  }

  try {
    const result = await loadPressings(masterId, from, token, Date.now() + TIME_BUDGET_MS);
    if (result.next === null) res.setHeader('Cache-Control', PRESSINGS_CACHE_CONTROL);
    res.status(200).json(result);
  } catch {
    res.status(502).json({ error: 'Discogs lookup failed' });
  }
}
