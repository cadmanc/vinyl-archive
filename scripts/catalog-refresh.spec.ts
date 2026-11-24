import type { DiscogsCollectionItem } from '../api/_catalog-format';
import { buildCatalog, needsLookup, releaseDetails, type CatalogFile } from './catalog-refresh';

const item = (id: number, instanceId = id * 10, masterId?: number): DiscogsCollectionItem => ({
  instance_id: instanceId,
  date_added: '2026-01-01',
  basic_information: {
    id,
    title: `Album ${id}`,
    artists: [{ id: 1, name: 'Artist' }],
    year: 2020,
    master_id: masterId,
    formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP'] }],
    labels: [{ name: 'Label', catno: 'CAT' }],
  },
});

const details = {
  year: 2021,
  master_id: 500,
  labels: [{ name: 'Atlantic', catno: 'SD 8216' }],
  formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }],
  tracklist: [
    { position: 'A', title: 'Side A', type: 'heading' },
    { position: 'A1', title: 'One', duration: '3:00', type: 'track' },
    { position: 'A2', title: 'Two', duration: '4:30', type: 'track' },
  ],
};

describe('releaseDetails', () => {
  it('fills in the same fields the site looks up', () => {
    expect(releaseDetails(details)).toEqual(
      expect.objectContaining({
        masterId: 500,
        label: 'Atlantic',
        catalogNumber: 'SD 8216',
        format: '2×LP, Album',
        year: 2021,
        detailsFetched: true,
        trackCount: 2,
        totalRuntimeSeconds: 450,
      }),
    );
  });

  it('leaves out the runtime when a track has no duration', () => {
    const result = releaseDetails({ tracklist: [{ position: 'A1', title: 'One' }] });
    expect(result.totalRuntimeSeconds).toBeUndefined();
  });
});

describe('buildCatalog', () => {
  const always = () => true;

  it('looks up new records once, even with several copies', async () => {
    const get = jest.fn(async (pathname: string) => {
      if (pathname === '/releases/1') return details;
      if (pathname === '/masters/500') return { year: 1971 };
      throw new Error(`unexpected ${pathname}`);
    });
    const musicBrainz = jest.fn();

    const catalog = await buildCatalog(
      [item(1, 10), item(1, 11)],
      null,
      get as never,
      musicBrainz,
      always,
    );

    expect(get).toHaveBeenCalledTimes(2);
    expect(catalog.releases).toHaveLength(2);
    expect(catalog.releases.map((release) => release.instanceId)).toEqual([10, 11]);
    for (const release of catalog.releases) {
      expect(release.basicInfo).toEqual(
        expect.objectContaining({ originalYear: 1971, trackCount: 2, detailsFetched: true }),
      );
    }
    expect(musicBrainz).not.toHaveBeenCalled();
  });

  it('reuses saved details, so an unchanged collection costs no lookups', async () => {
    const get = jest.fn(async (pathname: string) =>
      pathname === '/releases/1' ? details : { year: 1971 },
    );
    const first = await buildCatalog([item(1)], null, get as never, jest.fn(), always);
    get.mockClear();

    const second = await buildCatalog(
      [item(1)],
      first,
      get as never,
      jest.fn(),
      always,
      new Date(Date.parse(first.updatedAt) + 1000),
    );

    expect(get).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });

  it('falls back to MusicBrainz and remembers when no source has a year', async () => {
    const get = jest.fn(async () => ({ tracklist: [] }));
    const musicBrainz = jest.fn(async () => ({
      'release-groups': [
        {
          title: 'Album 1',
          score: 100,
          'first-release-date': '1984-05-01',
          'artist-credit': [{ name: 'Artist' }],
        },
      ],
    }));

    const found = await buildCatalog([item(1)], null, get as never, musicBrainz, always);
    expect(found.releases[0].basicInfo.originalYear).toBe(1984);

    musicBrainz.mockResolvedValueOnce({ 'release-groups': [] });
    const missing = await buildCatalog([item(2)], null, get as never, musicBrainz, always);
    expect(missing.releases[0].basicInfo.originalYearUnknown).toBe(true);
    expect(needsLookup(missing.releases[0])).toBe(false);
  });

  it('lists records it had no time for with basic details, for the next run', async () => {
    const get = jest.fn();
    const catalog = await buildCatalog([item(1)], null, get, jest.fn(), () => false);

    expect(get).not.toHaveBeenCalled();
    expect(catalog.releases[0].basicInfo.title).toBe('Album 1');
    expect(needsLookup(catalog.releases[0])).toBe(true);
  });

  it('drops records no longer in the collection', async () => {
    const previous: CatalogFile = {
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      releases: [{ id: 1, instanceId: 10, basicInfo: { title: 'Gone', artists: [], formats: [] } }],
    };
    const get = jest.fn(async () => ({ year: 1999, tracklist: [] }));
    const catalog = await buildCatalog(
      [item(2, 20, 600)],
      previous,
      get as never,
      jest.fn(),
      always,
    );
    expect(catalog.releases.map((release) => release.id)).toEqual([2]);
  });
});
