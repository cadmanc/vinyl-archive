/**
 * Saves everything the site shows to DATA_DIR, so browsers never wait on Discogs: the
 * catalog with record details (catalog.json), each artist's official vinyl albums
 * (summary.json plus one progress file per artist) and the pressings of every missing album
 * (pressings/). The owner's wantlist is saved to the owner-data branch. Runs in GitHub
 * Actions; the workflow publishes DATA_DIR to the missing-albums-data branch, which the
 * site reads. Progress is saved as it goes, so a run can stop at any point.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  creditsAllArtists,
  discogsGet,
  DiscogsNotFoundError,
  isVinylAlbum,
  isVinylEp,
  sleep,
  type DiscogsArtistReleasesPage,
  type DiscogsMasterVersionsPage,
} from '../api/missing-albums.js';
import type { DiscogsCollectionItem } from '../api/_catalog-format.js';
import {
  readOwnerFile,
  sortedIds,
  updateOwnerFile,
  type HiddenAlbumsFile,
  type WantlistFile,
} from '../api/_owner-data.js';
import { buildCatalog, needsLookup, type CatalogFile } from './catalog-refresh.js';
import {
  pressingsFileName,
  pressingsOrder,
  refreshPressings,
  type PressingsFile,
  type WantedAlbum,
} from './pressings-refresh.js';
import { typedAlbums, typedMatch, type TypedAlbum } from './album-types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// The workflow runs daily for collection and wantlist changes; discographies are listed
// again about twice a week to find titles added since.
const CHECK_INTERVAL_MS = 3 * DAY_MS - 2 * 60 * 60 * 1000;
// Titles that had no vinyl album are only looked at again this often, for new reissues.
const FULL_CHECK_INTERVAL_MS = 180 * DAY_MS;
const VARIOUS_ARTISTS_ID = 194;
// Leaves part of the shared Discogs rate limit for the owner's changes on the site.
const MIN_REQUEST_GAP_MS = 1_250;
// MusicBrainz asks for at most one request per second.
const MUSICBRAINZ_GAP_MS = 1_100;
const MUSICBRAINZ_ATTEMPTS = 4;
const MUSICBRAINZ_URL = 'https://musicbrainz.org/ws/2/';
const USER_AGENT = 'VinylArchive/1.0 (https://records.psamera.com)';
const SAVE_EVERY_REQUESTS = 50;
/** Bumped when the rules for which titles count as albums change, so every artist is redone. */
export const ALBUM_RULES = 3;

export interface ArtistCredit {
  id: number;
  name: string;
}

export interface ArtistMaster {
  masterId: number;
  title: string;
  year?: number;
}

export interface ArtistDocument {
  cachedAt: string;
  artists: ArtistCredit[];
  masters: ArtistMaster[];
  pagesFetched: number;
  totalPages?: number;
  checked: number;
  albums: ArtistMaster[];
  /** Titles checked that have no official vinyl album pressing. */
  nonAlbums: number[];
  complete: boolean;
  /** When titles without a vinyl album were last all looked at again. */
  fullCheckAt: string;
  /** Results from the previous check, still shown while a recheck is in progress. */
  previousAlbums?: ArtistMaster[];
  /** Earlier verdicts reused by a recheck, so only new titles cost a Discogs request. */
  known?: { albums: number[]; nonAlbums: number[] };
  /** The rules the albums were chosen by; see ALBUM_RULES. */
  rules?: number;
  /**
   * The artist's studio, live and remix albums and EPs on MusicBrainz, or null when MusicBrainz
   * doesn't know the artist and every vinyl album is listed.
   */
  typedAlbums?: TypedAlbum[] | null;
}

export interface SummaryEntry {
  cachedAt: string;
  complete: boolean;
  albums: ArtistMaster[] | null;
  /** Progress while a check is underway; total is known once the discography is listed. */
  checked?: number;
  total?: number;
}

export interface MissingAlbumsSummary {
  artists: Record<string, SummaryEntry>;
}

interface CollectionPage {
  pagination: { pages: number };
  releases: DiscogsCollectionItem[];
}

interface WantsPage {
  pagination: { pages: number };
  wants: Array<{ id: number }>;
}

/** Matches how the site keys an artist credit: every credited name, joined by "|". */
export function catalogKey(artists: ArtistCredit[]): string {
  return artists.map((artist) => artist.name).join('|');
}

export function artistFileName(artists: ArtistCredit[]): string {
  return `artist-${artists.map((artist) => artist.id).join('-')}.json`;
}

/** One entry per artist credit in the collection, skipping Various Artists. */
export function collectionArtists(credits: ArtistCredit[][]): Map<string, ArtistCredit[]> {
  const artists = new Map<string, ArtistCredit[]>();
  for (const credit of credits) {
    if (credit.length === 0 || credit[0].id === VARIOUS_ARTISTS_ID) continue;
    const key = catalogKey(credit);
    if (!artists.has(key)) artists.set(key, credit);
  }
  return artists;
}

export function isDue(document: ArtistDocument | undefined, now = Date.now()): boolean {
  return (
    !document ||
    !document.complete ||
    document.rules !== ALBUM_RULES ||
    now - Date.parse(document.cachedAt) > CHECK_INTERVAL_MS
  );
}

/**
 * Artists never checked come first, then ones mid-check, then the oldest results, so a huge
 * discography that takes many runs doesn't hold up the rest of the collection.
 */
export function refreshOrder(
  artists: Map<string, ArtistCredit[]>,
  documents: Map<string, ArtistDocument>,
  now = Date.now(),
): string[] {
  const rank = (key: string) => {
    const document = documents.get(key);
    if (!document) return -Infinity;
    return document.complete ? Date.parse(document.cachedAt) : Number.MIN_SAFE_INTEGER;
  };
  return [...artists.keys()]
    .filter((key) => isDue(documents.get(key), now))
    .sort((left, right) => rank(left) - rank(right));
}

export function summaryEntry(document: ArtistDocument): SummaryEntry {
  const entry: SummaryEntry = {
    cachedAt: document.cachedAt,
    complete: document.complete,
    albums: document.complete ? document.albums : (document.previousAlbums ?? null),
  };
  if (!document.complete) {
    entry.checked = document.checked;
    const listed =
      document.totalPages !== undefined && document.pagesFetched >= document.totalPages;
    if (listed) entry.total = document.masters.length;
  }
  return entry;
}

export function buildSummary(
  artists: Map<string, ArtistCredit[]>,
  documents: Map<string, ArtistDocument>,
): MissingAlbumsSummary {
  const summary: MissingAlbumsSummary = { artists: {} };
  for (const key of artists.keys()) {
    const document = documents.get(key);
    if (document) summary.artists[key] = summaryEntry(document);
  }
  return summary;
}

export function startDocument(
  artists: ArtistCredit[],
  previous?: ArtistDocument,
  now = Date.now(),
): ArtistDocument {
  const earlier = previous?.complete ? previous : undefined;
  // Results chosen by older rules aren't shown while the artist is redone.
  const showable = (document?: ArtistDocument) =>
    document?.rules === ALBUM_RULES ? document : undefined;
  const fullCheck = !earlier || now - Date.parse(earlier.fullCheckAt) > FULL_CHECK_INTERVAL_MS;
  // New releases often reach Discogs before their vinyl does, so recent titles without a
  // vinyl album are looked at again on every recheck, not just every six months.
  const recentFrom = new Date(now).getUTCFullYear() - 1;
  const recent = new Set(
    earlier?.masters
      .filter((master) => (master.year ?? 0) >= recentFrom)
      .map((master) => master.masterId),
  );
  return {
    cachedAt: new Date(now).toISOString(),
    artists,
    masters: [],
    pagesFetched: 0,
    checked: 0,
    albums: [],
    nonAlbums: [],
    complete: false,
    rules: ALBUM_RULES,
    fullCheckAt: fullCheck ? new Date(now).toISOString() : earlier.fullCheckAt,
    previousAlbums: showable(earlier)?.albums ?? showable(previous)?.previousAlbums,
    known: earlier && {
      albums: earlier.albums.map((album) => album.masterId),
      nonAlbums: fullCheck ? [] : earlier.nonAlbums.filter((masterId) => !recent.has(masterId)),
    },
  };
}

/**
 * Whether a title is a vinyl album without asking Discogs: owned titles never show as
 * missing, and a recheck reuses earlier verdicts. Undefined means it needs a request.
 */
export function knownVerdict(
  masterId: number,
  document: ArtistDocument,
  ownedMasters: Set<number>,
): boolean | undefined {
  if (ownedMasters.has(masterId) || document.known?.albums.includes(masterId)) return true;
  if (document.known?.nonAlbums.includes(masterId)) return false;
  return undefined;
}

class Refresher {
  private lastRequestAt = 0;
  private lastMusicBrainzAt = 0;
  private requestsSinceSave = 0;

  constructor(
    private readonly token: string,
    private readonly dataDir: string,
    private readonly deadline: number,
  ) {}

  timeLeft(): boolean {
    return Date.now() < this.deadline;
  }

  async get<T>(pathname: string, params: Record<string, string> = {}): Promise<T> {
    const wait = this.lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    this.requestsSinceSave++;
    return discogsGet<T>(pathname, this.token, params);
  }

  async musicBrainz<T>(query: string): Promise<T> {
    const result = await this.musicBrainzGet<T>('release-group/', { query, limit: '20' });
    if (!result) throw new Error('MusicBrainz request failed with 404');
    return result;
  }

  async musicBrainzGet<T>(pathname: string, params: Record<string, string>): Promise<T | null> {
    const url = new URL(pathname, MUSICBRAINZ_URL);
    url.search = new URLSearchParams({ ...params, fmt: 'json' }).toString();
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastMusicBrainzAt + MUSICBRAINZ_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastMusicBrainzAt = Date.now();
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 404) return null;
      // MusicBrainz answers 503 when it's busy or the shared runner address is asking too often.
      if (response.status !== 503 || attempt >= MUSICBRAINZ_ATTEMPTS) {
        throw new Error(`MusicBrainz request failed with ${response.status}`);
      }
      await sleep(attempt * 5_000);
    }
  }

  async collection(username: string): Promise<{
    items: DiscogsCollectionItem[];
    credits: ArtistCredit[][];
    ownedMasters: Set<number>;
  }> {
    const items: DiscogsCollectionItem[] = [];
    for (let page = 1; ; page++) {
      const data = await this.get<CollectionPage>(
        `/users/${encodeURIComponent(username)}/collection/folders/0/releases`,
        { per_page: '100', page: String(page) },
      );
      items.push(...data.releases);
      if (page >= data.pagination.pages) break;
    }
    const credits = items.map((item) => item.basic_information.artists as ArtistCredit[]);
    const ownedMasters = new Set(
      items.map((item) => item.basic_information.master_id).filter((id): id is number => !!id),
    );
    return { items, credits, ownedMasters };
  }

  async wantlist(username: string): Promise<number[]> {
    const ids: number[] = [];
    for (let page = 1; ; page++) {
      const data = await this.get<WantsPage>(`/users/${encodeURIComponent(username)}/wants`, {
        per_page: '100',
        page: String(page),
      });
      ids.push(...data.wants.map((want) => want.id));
      if (page >= data.pagination.pages) return sortedIds(ids);
    }
  }

  async check(document: ArtistDocument, ownedMasters: Set<number>): Promise<void> {
    const [artist, ...partners] = document.artists;
    const partnerNames = partners.map((partner) => partner.name);
    while (
      (document.totalPages === undefined || document.pagesFetched < document.totalPages) &&
      this.timeLeft()
    ) {
      const data = await this.get<DiscogsArtistReleasesPage>(`/artists/${artist.id}/releases`, {
        sort: 'year',
        sort_order: 'asc',
        per_page: '100',
        page: String(document.pagesFetched + 1),
      });
      document.masters.push(
        ...data.releases
          .filter(
            (item) =>
              item.type === 'master' &&
              item.role === 'Main' &&
              creditsAllArtists(item.artist, partnerNames),
          )
          .map((item) => ({ masterId: item.id, title: item.title, year: item.year || undefined })),
      );
      document.pagesFetched++;
      document.totalPages = data.pagination.pages;
      await this.saveIfDue(document);
    }

    const listed =
      document.totalPages !== undefined && document.pagesFetched >= document.totalPages;
    if (listed && document.typedAlbums === undefined && this.timeLeft()) {
      document.typedAlbums = await typedAlbums(document.artists, (pathname, params) =>
        this.musicBrainzGet(pathname, params),
      );
      await this.save(document);
    }
    while (
      listed &&
      document.typedAlbums !== undefined &&
      document.checked < document.masters.length &&
      this.timeLeft()
    ) {
      const master = document.masters[document.checked];
      const typed = document.typedAlbums && typedMatch(master, document.typedAlbums);
      if (document.typedAlbums && !typed) {
        document.checked++;
        continue;
      }
      try {
        let album = knownVerdict(master.masterId, document, ownedMasters);
        // Earlier checks only accepted full albums, so an EP's earlier "no" is asked again.
        if (album === false && typed?.ep) album = undefined;
        if (album === undefined) {
          const data = await this.get<DiscogsMasterVersionsPage>(
            `/masters/${master.masterId}/versions`,
            { format: 'Vinyl', per_page: '100' },
          );
          album = typed?.ep ? isVinylEp(data.versions) : isVinylAlbum(data.versions);
        }
        if (album) document.albums.push(master);
        else document.nonAlbums.push(master.masterId);
      } catch (error) {
        // A master Discogs can't return is skipped rather than blocking the rest of the artist.
        console.warn(`Skipping master ${master.masterId}:`, error);
      }
      document.checked++;
      await this.saveIfDue(document);
    }

    document.complete =
      listed && document.typedAlbums !== undefined && document.checked >= document.masters.length;
    if (document.complete) {
      delete document.known;
      delete document.typedAlbums;
    }
    await this.save(document);
  }

  private async saveIfDue(document: ArtistDocument): Promise<void> {
    if (this.requestsSinceSave >= SAVE_EVERY_REQUESTS) await this.save(document);
  }

  async save(document: ArtistDocument): Promise<void> {
    this.requestsSinceSave = 0;
    await writeFile(
      path.join(this.dataDir, 'artists', artistFileName(document.artists)),
      JSON.stringify(document),
    );
  }
}

export function totalProgress(documents: Map<string, ArtistDocument>): number {
  let total = 0;
  for (const document of documents.values()) {
    total += document.pagesFetched + document.checked + (document.complete ? 1 : 0);
  }
  return total;
}

/** Unchanged files leave the published branch untouched, so quiet runs publish nothing. */
async function writeIfChanged(file: string, contents: string): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== contents) await writeFile(file, contents);
}

async function readDocuments(
  dataDir: string,
  artists: Map<string, ArtistCredit[]>,
): Promise<Map<string, ArtistDocument>> {
  const documents = new Map<string, ArtistDocument>();
  for (const [key, credit] of artists) {
    try {
      const text = await readFile(path.join(dataDir, 'artists', artistFileName(credit)), 'utf8');
      documents.set(key, JSON.parse(text) as ArtistDocument);
    } catch {
      // Not checked yet.
    }
  }
  return documents;
}

/** Removes progress files for artists no longer in the collection. */
async function pruneDocuments(dataDir: string, artists: Map<string, ArtistCredit[]>) {
  const keep = new Set([...artists.values()].map(artistFileName));
  for (const file of await readdir(path.join(dataDir, 'artists'))) {
    if (!keep.has(file)) await rm(path.join(dataDir, 'artists', file));
  }
}

/**
 * Albums that show as missing on the site (from finished checks, or the previous results
 * while a recheck runs), skipping owned ones. Hidden albums are left out by the caller.
 */
export function missingAlbums(
  documents: Map<string, ArtistDocument>,
  ownedMasters: Set<number>,
): WantedAlbum[] {
  const albums = new Map<number, WantedAlbum>();
  for (const document of documents.values()) {
    const shown = document.complete ? document.albums : (document.previousAlbums ?? []);
    for (const album of shown) {
      if (!ownedMasters.has(album.masterId)) {
        albums.set(album.masterId, { masterId: album.masterId, year: album.year });
      }
    }
  }
  return [...albums.values()];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readPressings(dir: string): Promise<Map<number, PressingsFile>> {
  const files = new Map<number, PressingsFile>();
  for (const name of await readdir(dir)) {
    const masterId = Number(name.match(/^master-(\d+)\.json$/)?.[1]);
    const file =
      Number.isInteger(masterId) && (await readJson<PressingsFile>(path.join(dir, name)));
    if (file) files.set(masterId, file);
  }
  return files;
}

/** Keeps the saved wantlist on the owner-data branch in step with Discogs. */
async function syncWantlist(refresher: Refresher, username: string): Promise<void> {
  const githubToken = process.env['GITHUB_TOKEN']?.trim();
  if (!githubToken) return;
  try {
    const releaseIds = await refresher.wantlist(username);
    await updateOwnerFile<WantlistFile>(
      'wantlist.json',
      githubToken,
      () => ({ releaseIds }),
      'Update the saved wantlist from Discogs',
    );
  } catch (error) {
    console.warn('Wantlist was not saved this run:', error);
  }
}

async function hiddenAlbums(): Promise<Set<number>> {
  const githubToken = process.env['GITHUB_TOKEN']?.trim();
  if (!githubToken) return new Set();
  const file = await readOwnerFile<HiddenAlbumsFile>('hidden-albums.json', githubToken);
  return new Set(file?.masterIds ?? []);
}

async function main(): Promise<void> {
  const token = process.env['DISCOGS_TOKEN']?.trim();
  const username = process.env['DISCOGS_USERNAME']?.trim();
  const dataDir = process.env['DATA_DIR'] ?? 'missing-albums-data';
  const minutes = Number(process.env['TIME_BUDGET_MINUTES'] ?? 20);
  if (!token || !username) throw new Error('DISCOGS_TOKEN and DISCOGS_USERNAME are required');

  const pressingsDir = path.join(dataDir, 'pressings');
  await mkdir(path.join(dataDir, 'artists'), { recursive: true });
  await mkdir(pressingsDir, { recursive: true });
  const refresher = new Refresher(token, dataDir, Date.now() + minutes * 60_000);
  const timeLeft = () => refresher.timeLeft();
  const { items, credits, ownedMasters } = await refresher.collection(username);

  const catalogFile = path.join(dataDir, 'catalog.json');
  const previousCatalog = await readJson<CatalogFile>(catalogFile);
  const catalogBefore = previousCatalog?.releases.filter(needsLookup).length ?? items.length;
  const catalog = await buildCatalog(
    items,
    previousCatalog,
    (pathname, params) => refresher.get(pathname, params),
    (query) => refresher.musicBrainz(query),
    timeLeft,
  );
  await writeIfChanged(catalogFile, JSON.stringify(catalog));
  const catalogRemaining = catalog.releases.filter(needsLookup).length;
  console.log(`Catalog: ${catalog.releases.length} copies, ${catalogRemaining} still need details`);

  await syncWantlist(refresher, username);

  const artists = collectionArtists(credits);
  const documents = await readDocuments(dataDir, artists);
  const progressBefore = totalProgress(documents);

  for (const key of refreshOrder(artists, documents)) {
    if (!refresher.timeLeft()) break;
    const existing = documents.get(key);
    const document =
      existing && !existing.complete && existing.rules === ALBUM_RULES
        ? existing
        : startDocument(artists.get(key)!, existing);
    documents.set(key, document);
    try {
      await refresher.check(document, ownedMasters);
    } catch (error) {
      if (error instanceof DiscogsNotFoundError && document.pagesFetched === 0) {
        // Placeholder credits like "No Artist" have no discography to check.
        Object.assign(document, { totalPages: 0, complete: true });
        delete document.known;
      } else {
        // Progress so far is kept; the artist is picked up again next run.
        console.warn(`Stopped checking ${key}:`, error);
      }
      await refresher.save(document);
    }
    console.log(
      `${key}: ${document.complete ? 'done' : 'in progress'} (${document.checked}/${document.masters.length})`,
    );
  }

  await pruneDocuments(dataDir, artists);
  await writeIfChanged(
    path.join(dataDir, 'summary.json'),
    JSON.stringify(buildSummary(artists, documents)),
  );

  const missing = missingAlbums(documents, ownedMasters);
  const hidden = await hiddenAlbums();
  const wanted = missing.filter((album) => !hidden.has(album.masterId));
  const pressings = await readPressings(pressingsDir);
  let pressingsProgress = 0;
  for (const album of pressingsOrder(wanted, pressings)) {
    if (!refresher.timeLeft()) break;
    const before = pressings.get(album.masterId);
    const beforeState = `${before?.cachedAt}:${before?.next}`;
    try {
      const file = await refreshPressings(
        album.masterId,
        before,
        refresher.get.bind(refresher),
        timeLeft,
        (saved) =>
          writeFile(
            path.join(pressingsDir, pressingsFileName(album.masterId)),
            JSON.stringify(saved),
          ),
      );
      pressings.set(album.masterId, file);
      if (`${file.cachedAt}:${file.next}` !== beforeState) pressingsProgress++;
    } catch (error) {
      console.warn(`Pressings for master ${album.masterId} are left for the next run:`, error);
    }
  }
  // Hidden albums keep their saved pressings in case they're unhidden.
  const keep = new Set(missing.map((album) => pressingsFileName(album.masterId)));
  for (const name of await readdir(pressingsDir)) {
    if (!keep.has(name)) await rm(path.join(pressingsDir, name));
  }
  const pressingsRemaining = pressingsOrder(wanted, pressings).length;
  console.log(`Pressings: ${wanted.length - pressingsRemaining} of ${wanted.length} albums saved`);

  const remaining = refreshOrder(artists, documents).length + pressingsRemaining + catalogRemaining;
  // With nothing gained this run, what's left keeps failing; don't keep retrying it.
  const progressed =
    totalProgress(documents) > progressBefore ||
    pressingsProgress > 0 ||
    catalogRemaining < catalogBefore;
  console.log(`Remaining: ${remaining}; progressed: ${progressed}`);
  if (process.env['GITHUB_OUTPUT']) {
    await writeFile(
      process.env['GITHUB_OUTPUT'],
      `remaining=${remaining}\nprogressed=${progressed}\n`,
      { flag: 'a' },
    );
  }
}

if (process.argv[1]?.endsWith('missing-albums-refresh.ts')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
