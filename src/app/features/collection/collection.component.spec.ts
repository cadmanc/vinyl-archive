import { Release } from '../../shared/models/release.model';
import { CollectionComponent } from './collection.component';
import {
  artistSection,
  groupCollection,
  normalizeArtistSortKey,
  sortCollection,
} from './collection.utils';

describe('sortCollection', () => {
  const release = (
    id: number,
    artist: string,
    title: string,
    year?: number,
    originalYear?: number,
  ): Release => ({
    id,
    instanceId: id,
    basicInfo: { artists: [artist], title, year, originalYear, formats: [] },
    playCount: 0,
    dateAdded: new Date('2026-01-01'),
  });

  it('sorts artists, then original year, with pressing year fallback and title tie-break', () => {
    const releases = [
      release(1, 'B Artist', 'Later', 1990, 1980),
      release(2, 'A Artist', 'Zulu', 1995, 1970),
      release(3, 'A Artist', 'Alpha', 1985, 1970),
      release(4, 'A Artist', 'Fallback', 1980),
    ];

    expect(sortCollection(releases).map(({ id }) => id)).toEqual([3, 2, 4, 1]);
  });

  it('ignores leading articles when sorting and navigating artists', () => {
    expect(normalizeArtistSortKey('  The Beach Boys')).toBe('beach boys');
    expect(normalizeArtistSortKey('"The Rocky Horror Picture Show" Original Cast')).toBe(
      'rocky horror picture show" original cast',
    );
    expect(normalizeArtistSortKey('“The Rocky Horror Picture Show” Original Cast')).toBe(
      'rocky horror picture show” original cast',
    );
    expect(normalizeArtistSortKey("'The Example'")).toBe("example'");
    expect(artistSection('"The Rocky Horror Picture Show" Original Cast')).toBe('R');
    expect(artistSection('“The Rocky Horror Picture Show” Original Cast')).toBe('R');
    expect(artistSection("'The Example'")).toBe('E');
    expect(artistSection('Radiohead')).toBe('R');
    expect(
      sortCollection([release(1, 'The Beach Boys', 'A'), release(2, 'The Beatles', 'B')]).map(
        (item) => item.id,
      ),
    ).toEqual([1, 2]);
    expect(artistSection('The Beach Boys')).toBe('B');
    expect(artistSection('123 Records')).toBe('#');
    expect(artistSection('!Bang')).toBe('#');
  });

  it('groups artists while preserving separate pressings and chronological order', () => {
    const groups = groupCollection([
      release(1, 'The Beach Boys', 'Later Album', 2015, 1970),
      release(2, 'The Beach Boys', 'Earlier Album', 2010, 1965),
      release(3, 'The Beach Boys', 'Earlier Album', 2015, 1965),
      release(4, '9 Club', 'Numbered Album', 2020, 1980),
    ]);

    expect(groups.map((group) => group.heading)).toEqual(['9 Club', 'The Beach Boys']);
    expect(groups[1].releases.map((item) => item.id)).toEqual([2, 3, 1]);
    expect(groups[1].releases).toHaveLength(3);
    expect(artistSection(groups[0].heading)).toBe('#');
  });
});

describe('CollectionComponent original year display', () => {
  it('distinguishes fetching and completed unknown states', () => {
    const component = new CollectionComponent({} as any, {} as any);
    const item: Release = {
      id: 1,
      instanceId: 1,
      basicInfo: { title: 'Album', artists: ['Artist'], formats: [] },
      playCount: 0,
      dateAdded: new Date(),
    };

    component.resolutionStates.set({ 1: 'fetching' });
    expect(component.originalYear(item)).toBe('Fetching...');
    component.resolutionStates.set({ 1: 'unknown' });
    expect(component.originalYear(item)).toBe('Unknown');
  });

  it('toggles an expanded tracklist without changing the record', () => {
    const component = new CollectionComponent({} as any, {} as any);

    expect(component.isExpanded(7)).toBe(false);
    component.toggleExpanded(7);
    expect(component.isExpanded(7)).toBe(true);
    component.toggleExpanded(7);
    expect(component.isExpanded(7)).toBe(false);
  });

  it('formats runtime and label/catalog metadata compactly', () => {
    const component = new CollectionComponent({} as any, {} as any);
    const item: Release = {
      id: 7,
      instanceId: 7,
      basicInfo: {
        title: 'Album',
        artists: ['Artist'],
        formats: [],
        totalRuntimeSeconds: 245,
        label: 'Atlantic',
        catalogNumber: 'SD 16018',
        format: 'LP, Reissue',
        detailsFetched: true,
      },
      playCount: 0,
      dateAdded: new Date(),
    };

    expect(component.runtimeLabel(item)).toBe('4:05');
    expect(component.labelAndCatalog(item)).toBe('Atlantic · SD 16018');
    expect(component.formatLabel(item)).toBe('LP, Reissue');
  });

  it('shows Fetching before detail completion and Unknown after a completed empty result', () => {
    const component = new CollectionComponent({} as any, {} as any);
    const pending: Release = {
      id: 8,
      instanceId: 8,
      basicInfo: { title: 'Pending', artists: ['Artist'], formats: [] },
      playCount: 0,
      dateAdded: new Date(),
    };
    const completed = {
      ...pending,
      basicInfo: { ...pending.basicInfo, detailsFetched: true, tracklist: [], trackCount: 0 },
    };

    expect(component.trackCountLabel(pending)).toBe('Fetching...');
    expect(component.trackCountLabel(completed)).toBe(0);
    expect(component.labelAndCatalog(completed)).toBe('Unknown');
  });
});
