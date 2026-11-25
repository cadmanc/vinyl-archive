import {
  isTypedAlbum,
  isWantedAlbumType,
  typedAlbum,
  typedAlbums,
  type MusicBrainzLookup,
} from './album-types';

describe('isWantedAlbumType', () => {
  it.each([
    [[], true],
    [['Live'], true],
    [['Remix'], true],
    [['Compilation', 'Remix'], true],
    [['Compilation'], false],
    [['Compilation', 'Live'], false],
    [['Soundtrack'], false],
    [['Live', 'Remix'], false],
  ])('%j -> %s', (types, expected) => {
    expect(isWantedAlbumType(types)).toBe(expected);
  });
});

describe('isTypedAlbum', () => {
  const albums = [
    typedAlbum({
      title: 'Pet Sounds',
      'first-release-date': '1966-05-16',
      relations: [{ url: { resource: 'https://www.discogs.com/master/17217' } }],
    }),
    typedAlbum({ title: 'L.A. (Light Album)', 'first-release-date': '1979-03-16' }),
    typedAlbum({
      title: 'Labrinth, Sia & Diplo present… LSD (Remixes)',
      'first-release-date': '2024-02-02',
    }),
  ];

  it('matches by the Discogs master MusicBrainz links to', () => {
    expect(isTypedAlbum({ masterId: 17217, title: 'Pet Sounds (Mono)' }, albums)).toBe(true);
    expect(isTypedAlbum({ masterId: 99, title: 'Pet Sounds', year: 1966 }, albums)).toBe(false);
  });

  it('falls back to title and year for albums without a link', () => {
    expect(isTypedAlbum({ masterId: 5, title: 'L.A. (Light Album)', year: 1979 }, albums)).toBe(
      true,
    );
    expect(isTypedAlbum({ masterId: 6, title: 'L.A. (Light Album)', year: 1980 }, albums)).toBe(
      false,
    );
    expect(isTypedAlbum({ masterId: 7, title: 'L.A. (Light Album)' }, albums)).toBe(false);
    expect(isTypedAlbum({ masterId: 8, title: 'Remixes', year: 2024 }, albums)).toBe(true);
  });
});

describe('typedAlbum', () => {
  it('marks EPs', () => {
    expect(typedAlbum({ title: 'Four by the Beach Boys', 'primary-type': 'EP' }).ep).toBe(true);
    expect(typedAlbum({ title: 'Pet Sounds', 'primary-type': 'Album' }).ep).toBeUndefined();
  });
});

describe('typedAlbums', () => {
  it('keeps studio, live and remix albums of every credited artist', async () => {
    const lookup = jest.fn(async (pathname: string, params: Record<string, string>) => {
      if (pathname === 'url') {
        return params['resource'].endsWith('/1')
          ? { relations: [{ artist: { id: 'mb-1' } }] }
          : null;
      }
      return {
        'release-group-count': 3,
        'release-groups': [
          { title: 'Studio' },
          { title: 'Hits', 'secondary-types': ['Compilation'] },
          { title: 'Remixes', 'secondary-types': ['Remix'] },
        ],
      };
    }) as unknown as MusicBrainzLookup;

    const albums = await typedAlbums(
      [
        { id: 1, name: 'Known' },
        { id: 2, name: 'Unknown' },
      ],
      lookup,
    );

    expect(albums?.map((album) => album.title)).toEqual(['Studio', 'Remixes']);
  });

  it('returns null when MusicBrainz knows none of the artists', async () => {
    const lookup = (async () => null) as MusicBrainzLookup;
    expect(await typedAlbums([{ id: 1, name: 'Unknown' }], lookup)).toBeNull();
  });
});
