import { Release } from '../../shared/models/release.model';

export const COLLECTION_LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

export interface CollectionGroup {
  key: string;
  heading: string;
  releases: Release[];
}

export function displayArtist(release: Release): string {
  return release.basicInfo.artists.map(stripDiscogsNumber).join(', ');
}

export function normalizeArtistSortKey(artist: string): string {
  const normalized = artist
    .trim()
    .replace(/^["'“”‘’]+/, '')
    .trim()
    .toLocaleLowerCase();
  return normalized.replace(/^(the|an|a)\s+/, '');
}

export function artistSection(artist: string): string {
  const firstCharacter = normalizeArtistSortKey(artist).charAt(0).toUpperCase();
  return /^[A-Z]$/.test(firstCharacter) ? firstCharacter : '#';
}

export function collectionSortYear(release: Release): number {
  return release.basicInfo.originalYear ?? release.basicInfo.year ?? Number.POSITIVE_INFINITY;
}

export function sortCollection(releases: Release[]): Release[] {
  return [...releases].sort((left, right) => {
    const artistComparison = normalizeArtistSortKey(displayArtist(left)).localeCompare(
      normalizeArtistSortKey(displayArtist(right)),
      undefined,
      { sensitivity: 'base' },
    );
    if (artistComparison !== 0) return artistComparison;

    const yearComparison = collectionSortYear(left) - collectionSortYear(right);
    if (yearComparison !== 0) return yearComparison;

    const titleComparison = left.basicInfo.title.localeCompare(right.basicInfo.title, undefined, {
      sensitivity: 'base',
    });
    if (titleComparison !== 0) return titleComparison;

    return left.id - right.id;
  });
}

function stripDiscogsNumber(artist: string): string {
  return artist.replace(/\s+\(\d+\)$/, '');
}

/**
 * A joint credit such as "Janis Joplin, Big Brother & The Holding Company" is listed under
 * its first artist when that artist also has solo records in the collection.
 */
function groupHeading(release: Release, soloArtists: Set<string>): string {
  const [first, ...others] = release.basicInfo.artists;
  return others.length > 0 && soloArtists.has(first)
    ? stripDiscogsNumber(first)
    : displayArtist(release);
}

export function groupCollection(releases: Release[]): CollectionGroup[] {
  const groups = new Map<string, CollectionGroup>();
  const soloArtists = new Set(
    releases
      .filter((release) => release.basicInfo.artists.length === 1)
      .map((release) => release.basicInfo.artists[0]),
  );

  for (const release of sortCollection(releases)) {
    const heading = groupHeading(release, soloArtists);
    const key = normalizeArtistSortKey(heading);
    const existing = groups.get(key);
    if (existing) {
      existing.releases.push(release);
    } else {
      groups.set(key, { key, heading, releases: [release] });
    }
  }

  for (const group of groups.values()) {
    group.releases.sort(
      (left, right) =>
        collectionSortYear(left) - collectionSortYear(right) ||
        left.basicInfo.title.localeCompare(right.basicInfo.title, undefined, {
          sensitivity: 'base',
        }) ||
        left.id - right.id,
    );
  }

  return [...groups.values()].sort((left, right) => {
    const sectionComparison = sectionRank(left.heading) - sectionRank(right.heading);
    if (sectionComparison !== 0) return sectionComparison;
    return normalizeArtistSortKey(left.heading).localeCompare(
      normalizeArtistSortKey(right.heading),
      undefined,
      { sensitivity: 'base' },
    );
  });
}

function sectionRank(artist: string): number {
  const section = artistSection(artist);
  return section === '#' ? 0 : section.charCodeAt(0) - 64;
}
