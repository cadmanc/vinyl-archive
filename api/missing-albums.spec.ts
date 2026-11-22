import handler, {
  creditsAllArtists,
  formatDescriptions,
  isAlbumVersion,
  isOfficialVersion,
  isVinylAlbum,
  parseYear,
  sortPressings,
  toPressing,
} from './missing-albums';

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

describe('missing albums pressings handler', () => {
  const versionsPage = {
    pagination: { pages: 1 },
    versions: [
      { id: 11, format: 'LP, Album', released: '1991', country: 'US' },
      { id: 12, format: 'LP, Album, Promo', released: '1991' },
      { id: 13, format: 'LP, Album, Reissue', released: '2019', country: 'UK' },
    ],
  };
  const detail = { formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP'], text: 'Red' }] };

  const response = () => {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      status: jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      setHeader: jest.fn((name: string, value: string) => {
        res.headers[name] = value;
        return res;
      }),
      json: jest.fn((body: unknown) => {
        res.body = body;
        return res;
      }),
    };
    return res;
  };

  beforeEach(() => {
    process.env['DISCOGS_TOKEN'] = 'token';
    global.fetch = jest.fn(async (url: string | URL) => {
      const body = String(url).includes('/versions') ? versionsPage : detail;
      return { ok: true, status: 200, headers: new Headers(), json: async () => body } as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    delete process.env['DISCOGS_TOKEN'];
  });

  it('returns official pressings with details from the requested position', async () => {
    const res = response();
    await handler({ method: 'GET', query: { masterId: '5', from: '1' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      next: null,
      pressings: [
        expect.objectContaining({ releaseId: 11, detailed: false }),
        expect.objectContaining({ releaseId: 13, detailed: true, discs: 2, details: 'Red' }),
      ],
    });
    expect(res.headers['Cache-Control']).toContain('s-maxage');
  });

  it('requires a master id', async () => {
    const res = response();
    await handler({ method: 'GET', query: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('reports Discogs failures', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }) as Response) as typeof fetch;
    const res = response();
    await handler({ method: 'GET', query: { masterId: '5' } }, res);
    expect(res.statusCode).toBe(502);
  });
});
