import {
  MissingAlbumsService,
  pressingLabel,
  pressingSummary,
  VinylPressing,
} from './missing-albums.service';

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

describe('MissingAlbumsService.loadPressings', () => {
  const service = new MissingAlbumsService();
  const basic = (releaseId: number, year: number): VinylPressing => ({
    releaseId,
    year,
    descriptions: ['LP'],
    detailed: false,
  });
  const detailed = (releaseId: number, year: number): VinylPressing => ({
    ...basic(releaseId, year),
    details: 'Red',
    detailed: true,
  });

  beforeEach(() => localStorage.clear());

  it('combines batches, sorts by year and saves the result in the browser', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pressings: [detailed(2, 2019), basic(1, 1991)], next: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pressings: [basic(2, 2019), detailed(1, 1991)], next: null }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const pressings = await service.loadPressings(42);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/missing-albums?masterId=42&from=0',
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/missing-albums?masterId=42&from=1',
      undefined,
    );
    expect(pressings).toEqual([detailed(1, 1991), detailed(2, 2019)]);

    fetchMock.mockClear();
    expect(await service.loadPressings(42)).toEqual(pressings);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports failures', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 502 }) as unknown as typeof fetch;
    await expect(service.loadPressings(7)).rejects.toThrow('502');
  });
});

describe('MissingAlbumsService.loadSummary', () => {
  it('reads the summary published by the GitHub workflow', async () => {
    const summary = { artists: {} };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => summary });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await new MissingAlbumsService().loadSummary()).toEqual(summary);
    expect(fetchMock.mock.calls[0][0]).toContain('raw.githubusercontent.com');
  });
});
