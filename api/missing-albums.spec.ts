import {
  collectionArtists,
  creditsAllArtists,
  refreshOrder,
  formatDescriptions,
  isAlbumVersion,
  isOfficialVersion,
  isVinylAlbum,
  parseYear,
  sortPressings,
  toPressing,
} from './missing-albums';

jest.mock('@vercel/blob', () => ({ get: jest.fn(), put: jest.fn() }));
jest.mock('@vercel/functions', () => ({ waitUntil: jest.fn() }));

const version = (format: string, id = 1) => ({ id, format });

describe('missing albums classification', () => {
  it('splits Discogs format strings into descriptions', () => {
    expect(formatDescriptions('LP, Album, Limited Edition')).toEqual([
      'LP',
      'Album',
      'Limited Edition',
    ]);
    expect(formatDescriptions(undefined)).toEqual([]);
  });

  it('treats unofficial releases, test pressings, and promos as unofficial', () => {
    expect(isOfficialVersion(version('LP, Album, Reissue'))).toBe(true);
    expect(isOfficialVersion(version('LP, Album, Unofficial Release'))).toBe(false);
    expect(isOfficialVersion(version('LP, Album, Test Pressing'))).toBe(false);
    expect(isOfficialVersion(version('LP, Album, Promo'))).toBe(false);
  });

  it('counts studio albums, live albums, and compilations but not singles or EPs', () => {
    expect(isAlbumVersion(version('LP, Album'))).toBe(true);
    expect(isAlbumVersion(version('LP, Compilation'))).toBe(true);
    expect(isAlbumVersion(version('7", Single'))).toBe(false);
    expect(isAlbumVersion(version('12", EP'))).toBe(false);
  });

  it('requires an official vinyl album pressing', () => {
    expect(isVinylAlbum([version('LP, Album, Unofficial Release'), version('LP, Album')])).toBe(
      true,
    );
    expect(isVinylAlbum([version('LP, Album, Unofficial Release')])).toBe(false);
    expect(isVinylAlbum([])).toBe(false);
  });

  it('reads years and treats Discogs "0" as unknown', () => {
    expect(parseYear('2019')).toBe(2019);
    expect(parseYear('2019-10-04')).toBe(2019);
    expect(parseYear('0')).toBeUndefined();
    expect(parseYear(undefined)).toBeUndefined();
  });
});

describe('collection refresh', () => {
  const release = (id: number, artists: string[]) =>
    ({ id, instanceId: id, basicInfo: { title: 'Album', artists, formats: [] } }) as never;

  it('lists each artist credit once and skips Various Artists', () => {
    const artists = collectionArtists([
      release(1, ['Nirvana']),
      release(2, ['Nirvana']),
      release(3, ['BadBadNotGood', 'Ghostface Killah']),
      release(4, ['Various']),
    ]);
    expect([...artists]).toEqual([
      ['Nirvana', 1],
      ['BadBadNotGood|Ghostface Killah', 3],
    ]);
  });

  it('checks new artists first, then unfinished ones, then the oldest stale results', () => {
    const now = Date.parse('2026-12-31T00:00:00Z');
    const artists = new Map([
      ['Fresh', 1],
      ['Old', 2],
      ['Older', 3],
      ['New', 4],
      ['Unfinished', 5],
    ]);
    const entry = (cachedAt: string, complete = true) => ({ cachedAt, complete, albums: [] });
    const order = refreshOrder(
      artists,
      {
        updatedAt: '',
        artists: {
          Fresh: entry('2026-12-30T00:00:00Z'),
          Old: entry('2026-10-01T00:00:00Z'),
          Older: entry('2026-09-01T00:00:00Z'),
          Unfinished: entry('2026-12-30T00:00:00Z', false),
        },
      },
      now,
    ).map(([key]) => key);

    expect(order).toEqual(['New', 'Unfinished', 'Older', 'Old']);
  });
});

describe('creditsAllArtists', () => {
  it('keeps every title for a solo artist', () => {
    expect(creditsAllArtists('BadBadNotGood', [])).toBe(true);
  });

  it('keeps only joint titles for a collaboration', () => {
    const partners = ['Ghostface Killah'];
    expect(creditsAllArtists('BadBadNotGood & Ghostface Killah', partners)).toBe(true);
    expect(creditsAllArtists('BadBadNotGood', partners)).toBe(false);
    expect(creditsAllArtists('BadBadNotGood & Little Dragon', partners)).toBe(false);
  });

  it('ignores Discogs disambiguation numbers', () => {
    expect(creditsAllArtists('Animated Violence & Total Vacation', ['Total Vacation (2)'])).toBe(
      true,
    );
  });
});

describe('toPressing', () => {
  const paramountUs = {
    id: 13485838,
    format: 'LP, Album, Limited Edition',
    released: '2019',
    country: 'US',
    label: 'DGC',
    catno: 'B0029542-01',
  };

  it('uses release details for disc count, colour, and weight', () => {
    expect(
      toPressing(paramountUs, {
        formats: [
          {
            name: 'Vinyl',
            qty: '2',
            descriptions: ['LP', 'Album', 'Limited Edition'],
            text: 'Orange 180g',
          },
        ],
      }),
    ).toEqual({
      releaseId: 13485838,
      year: 2019,
      country: 'US',
      label: 'DGC',
      catno: 'B0029542-01',
      discs: 2,
      descriptions: ['LP', 'Album', 'Limited Edition'],
      details: 'Orange 180g',
      detailed: true,
    });
  });

  it('falls back to the version format when details are not loaded', () => {
    expect(toPressing({ ...paramountUs, released: '0' })).toMatchObject({
      year: undefined,
      discs: undefined,
      descriptions: ['LP', 'Album', 'Limited Edition'],
      detailed: false,
    });
  });

  it('sorts pressings by year with unknown years last', () => {
    const pressings = [
      toPressing({ id: 3, released: '0' }),
      toPressing({ id: 2, released: '2023' }),
      toPressing({ id: 1, released: '2019' }),
    ];
    expect(sortPressings(pressings).map((pressing) => pressing.releaseId)).toEqual([1, 2, 3]);
  });
});
