/**
 * Which of an artist's Discogs masters are studio, live or remix albums. Discogs doesn't
 * record album types, so they come from MusicBrainz's official release groups, matched to
 * Discogs by the master link MusicBrainz keeps or, failing that, by title and exact year.
 */
import { normalizeMatchText } from './catalog-refresh.js';
import type { ArtistCredit, ArtistMaster } from './missing-albums-refresh.js';

export interface TypedAlbum {
  title: string;
  year?: number;
  masterIds: number[];
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

/** Studio albums have no secondary type; live and remix albums are the only extras kept. */
export function isWantedAlbumType(secondaryTypes: string[] = []): boolean {
  if (secondaryTypes.length === 0) return true;
  if (secondaryTypes.length === 1 && secondaryTypes[0] === 'Live') return true;
  // Remix albums are often also tagged as compilations.
  return (
    secondaryTypes.includes('Remix') &&
    secondaryTypes.every((type) => type === 'Remix' || type === 'Compilation')
  );
}

export function typedAlbum(group: MusicBrainzReleaseGroup): TypedAlbum {
  const year = Number(group['first-release-date']?.slice(0, 4));
  const masterIds = (group.relations ?? [])
    .map((relation) => relation.url?.resource?.match(DISCOGS_MASTER)?.[1])
    .filter((id): id is string => !!id)
    .map(Number);
  return { title: group.title, ...(year ? { year } : {}), masterIds };
}

/** Equal titles, or one is the other with a prefix such as "Artist present…". */
function sameTitle(left: string, right: string): boolean {
  const [a, b] = [normalizeMatchText(left), normalizeMatchText(right)];
  return !!a && !!b && (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`));
}

export function isTypedAlbum(master: ArtistMaster, albums: TypedAlbum[]): boolean {
  return albums.some(
    (album) =>
      album.masterIds.includes(master.masterId) ||
      (album.masterIds.length === 0 &&
        album.year === master.year &&
        sameTitle(album.title, master.title)),
  );
}

/**
 * Studio, live and remix albums credited to any of the artists. Null when MusicBrainz
 * doesn't know any of them, so the caller can fall back to listing every vinyl album.
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
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await lookup<MusicBrainzReleaseGroupsPage>('release-group', {
          artist: id,
          type: 'album',
          'release-group-status': 'website-default',
          inc: 'url-rels',
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        const groups = page?.['release-groups'] ?? [];
        albums.push(
          ...groups.filter((group) => isWantedAlbumType(group['secondary-types'])).map(typedAlbum),
        );
        if (
          groups.length < PAGE_SIZE ||
          offset + PAGE_SIZE >= (page?.['release-group-count'] ?? 0)
        ) {
          break;
        }
      }
    }
  }
  return found ? albums : null;
}
