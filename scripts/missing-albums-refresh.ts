/**
 * Checks every artist in the Discogs collection for official vinyl albums and writes the
 * results to DATA_DIR (summary.json plus one progress file per artist). Runs in GitHub
 * Actions; the workflow publishes DATA_DIR to the missing-albums-data branch, which the
 * site reads. Progress is saved after every artist, so a run can stop at any point.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  creditsAllArtists,
  discogsGet,
  isVinylAlbum,
  sleep,
  type DiscogsArtistReleasesPage,
  type DiscogsMasterVersionsPage,
} from '../api/missing-albums.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Each month a discography is listed again to find titles added since the last check.
const CHECK_INTERVAL_MS = 30 * DAY_MS;
// Titles that had no vinyl album are only looked at again this often, for new reissues.
const FULL_CHECK_INTERVAL_MS = 180 * DAY_MS;
const VARIOUS_ARTISTS_ID = 194;
// Leaves part of the shared Discogs rate limit for the site while this runs.
const MIN_REQUEST_GAP_MS = 1_300;
const SAVE_EVERY_REQUESTS = 50;

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
  releases: Array<{ basic_information: { artists: ArtistCredit[]; master_id?: number } }>;
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
  return !document || !document.complete || now - Date.parse(document.cachedAt) > CHECK_INTERVAL_MS;
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
  const fullCheck = !earlier || now - Date.parse(earlier.fullCheckAt) > FULL_CHECK_INTERVAL_MS;
  return {
    cachedAt: new Date(now).toISOString(),
    artists,
    masters: [],
    pagesFetched: 0,
    checked: 0,
    albums: [],
    nonAlbums: [],
    complete: false,
    fullCheckAt: fullCheck ? new Date(now).toISOString() : earlier.fullCheckAt,
    previousAlbums: earlier ? earlier.albums : previous?.previousAlbums,
    known: earlier && {
      albums: earlier.albums.map((album) => album.masterId),
      nonAlbums: fullCheck ? [] : earlier.nonAlbums,
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

  async collection(
    username: string,
  ): Promise<{ credits: ArtistCredit[][]; ownedMasters: Set<number> }> {
    const credits: ArtistCredit[][] = [];
    const ownedMasters = new Set<number>();
    for (let page = 1; ; page++) {
      const data = await this.get<CollectionPage>(
        `/users/${encodeURIComponent(username)}/collection/folders/0/releases`,
        { per_page: '100', page: String(page) },
      );
      for (const { basic_information: info } of data.releases) {
        credits.push(info.artists);
        if (info.master_id) ownedMasters.add(info.master_id);
      }
      if (page >= data.pagination.pages) return { credits, ownedMasters };
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
    while (listed && document.checked < document.masters.length && this.timeLeft()) {
      const master = document.masters[document.checked];
      try {
        let album = knownVerdict(master.masterId, document, ownedMasters);
        if (album === undefined) {
          const data = await this.get<DiscogsMasterVersionsPage>(
            `/masters/${master.masterId}/versions`,
            { format: 'Vinyl', per_page: '100' },
          );
          album = isVinylAlbum(data.versions);
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

    document.complete = listed && document.checked >= document.masters.length;
    if (document.complete) delete document.known;
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

async function main(): Promise<void> {
  const token = process.env['DISCOGS_TOKEN']?.trim();
  const username = process.env['DISCOGS_USERNAME']?.trim();
  const dataDir = process.env['DATA_DIR'] ?? 'missing-albums-data';
  const minutes = Number(process.env['TIME_BUDGET_MINUTES'] ?? 20);
  if (!token || !username) throw new Error('DISCOGS_TOKEN and DISCOGS_USERNAME are required');

  await mkdir(path.join(dataDir, 'artists'), { recursive: true });
  const refresher = new Refresher(token, dataDir, Date.now() + minutes * 60_000);
  const { credits, ownedMasters } = await refresher.collection(username);
  const artists = collectionArtists(credits);
  const documents = await readDocuments(dataDir, artists);
  const progressBefore = totalProgress(documents);

  for (const key of refreshOrder(artists, documents)) {
    if (!refresher.timeLeft()) break;
    const existing = documents.get(key);
    const document =
      existing && !existing.complete ? existing : startDocument(artists.get(key)!, existing);
    documents.set(key, document);
    try {
      await refresher.check(document, ownedMasters);
    } catch (error) {
      // Progress so far is kept; the artist is picked up again next run.
      console.warn(`Stopped checking ${key}:`, error);
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
  const remaining = refreshOrder(artists, documents).length;
  // With nothing gained this run, the artists left keep failing; don't keep retrying them.
  const progressed = totalProgress(documents) > progressBefore;
  console.log(`Remaining artists: ${remaining}; progressed: ${progressed}`);
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
