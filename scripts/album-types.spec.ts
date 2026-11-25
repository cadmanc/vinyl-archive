import {
  albumKindFromTypes,
  isTypedAlbum,
  isWantedAlbumType,
  typedAlbum,
  typedAlbums,
  type MusicBrainzLookup,
} from './album-types';

describe('albumKindFromTypes', () => {
  it.each([
    ['Album', [], 'album'],
    ['Album', ['Live'], 'album'],
    ['Album', ['Remix'], 'album'],
    ['Album', ['Compilation', 'Remix'], 'album'],
    ['Album', ['Compilation'], 'compilation'],
    ['Album', ['Compilation', 'Live'], 'compilation'],
    ['Album', ['Soundtrack'], null],
    ['Album', ['Live', 'Remix'], null],
    ['EP', [], 'ep'],
    ['EP', ['Compilation'], 'ep'],
    ['Single', [], null],
  ] as const)('%s %j -> %s', (primary, types, expected) => {
    expect(albumKindFromTypes(primary, [...types])).toBe(expected);
  });
});

describe('isWantedAlbumType', () => {
  it.each([
    [[], true],
    [['Live'], true],
    [['Remix'], true],
    [['Compilation', 'Remix'], true],
    [['Compilation'], true],
    [['Compilation', 'Live'], true],
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
    })!,
    typedAlbum({ title: 'L.A. (Light Album)', 'first-release-date': '1979-03-16' })!,
    typedAlbum({
      title: 'Labrinth, Sia & Diplo present… LSD (Remixes)',
      'first-release-date': '2024-02-02',
      'secondary-types': ['Remix'],
    })!,
    typedAlbum({
      title: 'Greatest Hits',
      'first-release-date': '2000-01-01',
      'secondary-types': ['Compilation'],
    })!,
    typedAlbum({ title: 'EP Title', 'primary-type': 'EP', 'first-release-date': '1995-01-01' })!,
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

  it('keeps compilations and EPs with their kinds', () => {
    expect(albums.find((album) => album.title === 'Greatest Hits')?.kind).toBe('compilation');
    expect(albums.find((album) => album.title === 'EP Title')?.kind).toBe('ep');
  });
});

describe('typedAlbums', () => {
  it('keeps studio, live, remix, compilation and EP releases of every credited artist', async () => {
    const lookup = jest.fn(async (pathname: string, params: Record<string, string>) => {
      if (pathname === 'url') {
        return params['resource'].endsWith('/1')
          ? { relations: [{ artist: { id: 'mb-1' } }] }
          : null;
      }
      if (params['type'] === 'ep') {
        return {
          'release-group-count': 1,
          'release-groups': [{ title: 'Short', 'primary-type': 'EP' }],
        };
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

    expect(albums?.map((album) => [album.title, album.kind])).toEqual([
      ['Studio', 'album'],
      ['Hits', 'compilation'],
      ['Remixes', 'album'],
      ['Short', 'ep'],
    ]);
  });

  it('returns null when MusicBrainz knows none of the artists', async () => {
    const lookup = (async () => null) as MusicBrainzLookup;
    expect(await typedAlbums([{ id: 1, name: 'Unknown' }], lookup)).toBeNull();
  });
});
