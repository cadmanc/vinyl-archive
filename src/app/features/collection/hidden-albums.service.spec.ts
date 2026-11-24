import { HiddenAlbumsService } from './hidden-albums.service';

const SAVED_URL =
  'https://raw.githubusercontent.com/cadmanc/vinyl-archive/owner-data/hidden-albums.json';

describe('HiddenAlbumsService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    localStorage.setItem('wantlist-owner-key', 'owner-secret');
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => localStorage.clear());

  const loaded = async (masterIds: number[]) => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ masterIds }) });
    const service = new HiddenAlbumsService();
    await service.load();
    return service;
  };

  it('reads hidden albums saved on GitHub, the same for every browser', async () => {
    const service = await loaded([42]);

    expect(fetchMock).toHaveBeenCalledWith(SAVED_URL, { cache: 'no-cache' });
    expect(service.isHidden(42)).toBe(true);
    expect(service.isHidden(7)).toBe(false);
  });

  it('hides an album for everyone and keeps it hidden here until GitHub catches up', async () => {
    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ masterIds: [42] }) });

    await service.hide(42);

    expect(fetchMock).toHaveBeenLastCalledWith('/api/hidden-albums?masterId=42', {
      method: 'PUT',
      headers: { 'X-Owner-Key': 'owner-secret' },
    });
    expect(service.isHidden(42)).toBe(true);
    expect((await loaded([])).isHidden(42)).toBe(true);
  });

  it('unhides an album', async () => {
    const service = await loaded([42]);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ masterIds: [] }) });

    await service.unhide(42);

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/hidden-albums?masterId=42',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(service.isHidden(42)).toBe(false);
  });

  it('lets only the owner change hidden albums', async () => {
    localStorage.clear();
    const service = await loaded([]);

    await service.hide(42);

    expect(service.canEdit()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an album shown when saving fails', async () => {
    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });

    await service.hide(42);

    expect(service.isHidden(42)).toBe(false);
    expect(service.isPending(42)).toBe(false);
  });

  it('moves albums hidden on this device before hiding was shared to the shared list', async () => {
    localStorage.setItem('hidden-missing-albums', JSON.stringify([42, 7]));
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ masterIds: [7] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ masterIds: [7, 42] }) });

    const service = new HiddenAlbumsService();
    await service.load();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/hidden-albums?masterId=42',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(service.isHidden(42)).toBe(true);
    expect(localStorage.getItem('hidden-missing-albums')).toBeNull();
  });
});
