/**
 * Which of an artist's Discogs masters are studio, live, remix, compilation or EP releases.
 * Discogs doesn't record album types, so they come from MusicBrainz's official release groups,
 * matched to Discogs by the master link MusicBrainz keeps or, failing that, by title and year.
 */
import { normalizeMatchText } from './catalog-refresh.js';
import type { ArtistCredit, ArtistMaster } from './missing-albums-refresh.js';

export type AlbumKind = 'album' | 'ep' | 'compilation';

export interface TypedAlbum {
  title: string;
  year?: number;
  masterIds: number[];
  kind: AlbumKind;
}

export interface MusicBrainzReleaseGroup {
  title: string;
  'first-release-date'?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  relations?: Array<{ url?: { resource?: string } }>;
}

export interface MusicBrainzReleaseGroupsPage {
  'release-group-count': number;
  'release-groups': MusicBrainzReleaseGroup[];
}

export interface MusicBrainzUrlLookup {
  relations?: Array<{ artist?: { id: string } }>;
}

/** Resolves to null when MusicBrainz has nothing at that path. */
export type MusicBrainzLookup = <T>(
  pathname: string,
  params: Record<string, string>,
) => Promise<T | null>;

const PAGE_SIZE = 100;
const DISCOGS_MASTER = /discogs\.com\/master\/(\d+)/;
const COMPILATION_SECONDARIES = new Set(['Compilation', 'Live']);

/**
 * Studio/live/remix albums stay visible by default. Official compilations and EPs are kept
 * too, but the refresh job hides them until the owner unhides one.
 */
export function albumKindFromTypes(
  primaryType: string | undefined,
  secondaryTypes: string[] = [],
): AlbumKind | null {
  const primary = primaryType || 'Album';
  if (primary === 'EP') return 'ep';
  if (primary !== 'Album') return null;

  if (secondaryTypes.length === 0) return 'album';
  if (secondaryTypes.length === 1 && secondaryTypes[0] === 'Live') return 'album';
  // Remix albums are often also tagged as compilations.
  if (
    secondaryTypes.includes('Remix') &&
    secondaryTypes.every((type) => type === 'Remix' || type === 'Compilation')
  ) {
    return 'album';
  }
  if (
    secondaryTypes.includes('Compilation') &&
    secondaryTypes.every((type) => COMPILATION_SECONDARIES.has(type))
  ) {
    return 'compilation';
  }
  return null;
}

/** @deprecated Prefer albumKindFromTypes; kept for existing call sites and tests. */
export function isWantedAlbumType(secondaryTypes: string[] = []): boolean {
  return albumKindFromTypes('Album', secondaryTypes) !== null;
}

export function typedAlbum(group: MusicBrainzReleaseGroup): TypedAlbum | null {
  const kind = albumKindFromTypes(group['primary-type'], group['secondary-types']);
  if (!kind) return null;
  const year = Number(group['first-release-date']?.slice(0, 4));
  const masterIds = (group.relations ?? [])
    .map((relation) => relation.url?.resource?.match(DISCOGS_MASTER)?.[1])
    .filter((id): id is string => !!id)
    .map(Number);
  return { title: group.title, ...(year ? { year } : {}), masterIds, kind };
}

/** Equal titles, or one is the other with a prefix such as "Artist present…". */
function sameTitle(left: string, right: string): boolean {
  const [a, b] = [normalizeMatchText(left), normalizeMatchText(right)];
  return !!a && !!b && (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`));
}

export function matchingTypedAlbum(
  master: ArtistMaster,
  albums: TypedAlbum[],
): TypedAlbum | undefined {
  return albums.find(
    (album) =>
      album.masterIds.includes(master.masterId) ||
      (album.masterIds.length === 0 &&
        album.year === master.year &&
        sameTitle(album.title, master.title)),
  );
}

export function isTypedAlbum(master: ArtistMaster, albums: TypedAlbum[]): boolean {
  return matchingTypedAlbum(master, albums) !== undefined;
}

async function releaseGroupsForType(
  artistId: string,
  type: 'album' | 'ep',
  lookup: MusicBrainzLookup,
): Promise<MusicBrainzReleaseGroup[]> {
  const groups: MusicBrainzReleaseGroup[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await lookup<MusicBrainzReleaseGroupsPage>('release-group', {
      artist: artistId,
      type,
      'release-group-status': 'website-default',
      inc: 'url-rels',
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const batch = page?.['release-groups'] ?? [];
    groups.push(...batch);
    if (batch.length < PAGE_SIZE || offset + PAGE_SIZE >= (page?.['release-group-count'] ?? 0)) {
      break;
    }
  }
  return groups;
}

/**
 * Studio, live, remix, compilation and EP releases credited to any of the artists. Null when
 * MusicBrainz doesn't know any of them, so the caller can fall back to Discogs formats.
 */
export async function typedAlbums(
  artists: ArtistCredit[],
  lookup: MusicBrainzLookup,
): Promise<TypedAlbum[] | null> {
  let found = false;
  const albums: TypedAlbum[] = [];
  for (const artist of artists) {
    const url = await lookup<MusicBrainzUrlLookup>('url', {
      resource: `https://www.discogs.com/artist/${artist.id}`,
      inc: 'artist-rels',
    });
    for (const id of new Set(url?.relations?.map((relation) => relation.artist?.id))) {
      if (!id) continue;
      found = true;
      for (const type of ['album', 'ep'] as const) {
        for (const group of await releaseGroupsForType(id, type, lookup)) {
          const album = typedAlbum({
            ...group,
            'primary-type': group['primary-type'] ?? (type === 'ep' ? 'EP' : 'Album'),
          });
          if (album) albums.push(album);
        }
      }
    }
  }
  return found ? albums : null;
}

export function isSecondaryKind(kind: AlbumKind | undefined): boolean {
  return kind === 'ep' || kind === 'compilation';
}
