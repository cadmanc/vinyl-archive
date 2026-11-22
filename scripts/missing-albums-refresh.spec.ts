import {
  buildSummary,
  knownVerdict,
  catalogKey,
  collectionArtists,
  refreshOrder,
  startDocument,
  summaryEntry,
  totalProgress,
  type ArtistDocument,
} from './missing-albums-refresh';

const nirvana = [{ id: 125246, name: 'Nirvana' }];
const sourSoul = [
  { id: 1, name: 'BadBadNotGood' },
  { id: 2, name: 'Ghostface Killah' },
];

const document = (overrides: Partial<ArtistDocument> = {}): ArtistDocument => ({
  cachedAt: '2026-11-19T00:00:00Z',
  artists: nirvana,
  masters: [
    { masterId: 1, title: 'Bleach' },
    { masterId: 2, title: 'Nevermind' },
  ],
  pagesFetched: 2,
  totalPages: 2,
  checked: 1,
  albums: [{ masterId: 1, title: 'Bleach' }],
  nonAlbums: [],
  complete: false,
  fullCheckAt: '2026-11-19T00:00:00Z',
  ...overrides,
});

describe('collectionArtists', () => {
  it('lists each artist credit once and skips Various Artists', () => {
    const artists = collectionArtists([nirvana, nirvana, sourSoul, [{ id: 194, name: 'Various' }]]);
    expect([...artists.keys()]).toEqual(['Nirvana', 'BadBadNotGood|Ghostface Killah']);
    expect(catalogKey(sourSoul)).toBe('BadBadNotGood|Ghostface Killah');
  });
});

describe('refreshOrder', () => {
  it('checks new artists first, then unfinished ones, then the oldest stale results', () => {
    const now = Date.parse('2026-12-31T00:00:00Z');
    const credit = (name: string) => [{ id: name.length, name }];
    const artists = new Map(
      ['Fresh', 'Old', 'Older', 'New', 'Unfinished'].map((name) => [name, credit(name)]),
    );
    const documents = new Map([
      ['Fresh', document({ cachedAt: '2026-12-30T00:00:00Z', complete: true })],
      ['Old', document({ cachedAt: '2026-10-01T00:00:00Z', complete: true })],
      ['Older', document({ cachedAt: '2026-09-01T00:00:00Z', complete: true })],
      ['Unfinished', document({ cachedAt: '2026-12-30T00:00:00Z' })],
    ]);

    expect(refreshOrder(artists, documents, now)).toEqual(['New', 'Unfinished', 'Older', 'Old']);
  });
});

describe('summaryEntry', () => {
  it('reports progress while a check is underway', () => {
    expect(summaryEntry(document())).toEqual({
      cachedAt: '2026-11-19T00:00:00Z',
      complete: false,
      albums: null,
      checked: 1,
      total: 2,
    });
  });

  it('leaves the total out until the discography is fully listed', () => {
    expect(summaryEntry(document({ pagesFetched: 1, totalPages: 3 })).total).toBeUndefined();
  });

  it('keeps the earlier albums while a stale result is rechecked', () => {
    const previous = document({ complete: true });
    const recheck = startDocument(nirvana, previous);
    expect(summaryEntry(recheck).albums).toEqual(previous.albums);
  });

  it('reports the albums once complete', () => {
    expect(summaryEntry(document({ complete: true }))).toEqual({
      cachedAt: '2026-11-19T00:00:00Z',
      complete: true,
      albums: [{ masterId: 1, title: 'Bleach' }],
    });
  });
});

describe('rechecks', () => {
  const now = Date.parse('2026-12-31T00:00:00Z');
  const earlier = document({
    complete: true,
    checked: 2,
    nonAlbums: [2],
    fullCheckAt: '2026-11-01T00:00:00Z',
  });

  it('reuses earlier verdicts so only new titles need a Discogs request', () => {
    const recheck = startDocument(nirvana, earlier, now);
    const owned = new Set([99]);
    expect(knownVerdict(1, recheck, owned)).toBe(true);
    expect(knownVerdict(2, recheck, owned)).toBe(false);
    expect(knownVerdict(99, recheck, owned)).toBe(true);
    expect(knownVerdict(3, recheck, owned)).toBeUndefined();
    expect(recheck.fullCheckAt).toBe(earlier.fullCheckAt);
  });

  it('looks at titles without a vinyl album again every six months', () => {
    const recheck = startDocument(
      nirvana,
      { ...earlier, fullCheckAt: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(knownVerdict(2, recheck, new Set())).toBeUndefined();
    expect(knownVerdict(1, recheck, new Set())).toBe(true);
    expect(recheck.fullCheckAt).toBe(new Date(now).toISOString());
  });

  it('checks every title of a new artist', () => {
    const first = startDocument(nirvana, undefined, now);
    expect(knownVerdict(1, first, new Set())).toBeUndefined();
  });
});

describe('buildSummary', () => {
  it('includes only artists still in the collection that have been started', () => {
    const artists = new Map([
      ['Nirvana', nirvana],
      ['BadBadNotGood|Ghostface Killah', sourSoul],
    ]);
    const documents = new Map([
      ['Nirvana', document({ complete: true })],
      ['Sold Artist', document({ complete: true })],
    ]);
    expect(Object.keys(buildSummary(artists, documents).artists)).toEqual(['Nirvana']);
  });
});

describe('totalProgress', () => {
  it('grows as pages are listed, titles are checked and artists finish', () => {
    const before = totalProgress(new Map([['Nirvana', document()]]));
    const after = totalProgress(new Map([['Nirvana', document({ checked: 2, complete: true })]]));
    expect(after - before).toBe(2);
  });
});
