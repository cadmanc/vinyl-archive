import { pressingLabel, pressingSummary, VinylPressing } from './missing-albums.service';

describe('pressingSummary', () => {
  const pressing = (overrides: Partial<VinylPressing>): VinylPressing => ({
    releaseId: 1,
    descriptions: ['LP', 'Album'],
    ...overrides,
  });

  it('describes a coloured limited edition double LP', () => {
    expect(
      pressingSummary(
        pressing({
          year: 2019,
          country: 'US',
          discs: 2,
          descriptions: ['LP', 'Album', 'Limited Edition'],
          details: 'Orange 180g',
        }),
      ),
    ).toBe('2019 US · Limited Edition · Orange 180g · 2LP');
  });

  it('describes a single LP reissue', () => {
    expect(
      pressingSummary(
        pressing({
          year: 2023,
          country: 'Europe',
          discs: 1,
          descriptions: ['LP', 'Album', 'Reissue', 'Stereo'],
        }),
      ),
    ).toBe('2023 Europe · Reissue · LP');
  });

  it('marks pressings without a year', () => {
    expect(pressingSummary(pressing({ country: 'US', discs: 2 }))).toBe('Year unknown US · 2LP');
  });

  it('joins label and catalog number', () => {
    expect(pressingLabel(pressing({ label: 'DGC', catno: 'B0029541-01' }))).toBe(
      'DGC · B0029541-01',
    );
    expect(pressingLabel(pressing({ label: 'DGC' }))).toBe('DGC');
  });
});
