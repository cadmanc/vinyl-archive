import { WantlistService } from './wantlist.service';

const KEY_STORAGE = 'wantlist-owner-key';
const SAVED_URL =
  'https://raw.githubusercontent.com/cadmanc/vinyl-archive/owner-data/wantlist.json';

describe('WantlistService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    localStorage.setItem(KEY_STORAGE, 'owner-secret');
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  const ownerRequest = (method: string) =>
    expect.objectContaining({ method, headers: { 'X-Owner-Key': 'owner-secret' } });

  const loaded = async (releaseIds: number[]) => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ releaseIds }) });
    const service = new WantlistService();
    await service.load();
    return service;
  };

  it('reads the saved wantlist from GitHub once per visit', async () => {
    const service = await loaded([1, 2]);
    await service.load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(SAVED_URL, { cache: 'no-cache' });
    expect(service.isWanted(1)).toBe(true);
    expect(service.isWanted(3)).toBe(false);
  });

  it('shows an empty wantlist before the first one is saved', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
    const service = new WantlistService();
    await service.load();
    expect(service.wanted()?.size).toBe(0);
  });

  it('shows visitors the wantlist without letting them change it', async () => {
    localStorage.clear();
    const service = await loaded([1]);

    await service.toggle(5);

    expect(service.canEdit()).toBe(false);
    expect(service.isWanted(1)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('saves the key from the owner link and removes it from the address bar', async () => {
    localStorage.clear();
    window.history.replaceState(null, '', '/?view=list#owner=new%20key');

    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: true });
    await service.toggle(5);

    expect(localStorage.getItem(KEY_STORAGE)).toBe('new key');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?view=list');
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/wantlist?releaseId=5',
      expect.objectContaining({ headers: { 'X-Owner-Key': 'new key' } }),
    );
  });

  it('adds a pressing and keeps the change on this device until GitHub catches up', async () => {
    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await service.toggle(5);

    expect(fetchMock).toHaveBeenLastCalledWith('/api/wantlist?releaseId=5', ownerRequest('PUT'));
    expect(service.isWanted(5)).toBe(true);
    expect(service.isPending(5)).toBe(false);

    const reloaded = await loaded([]);
    expect(reloaded.isWanted(5)).toBe(true);
  });

  it('removes a pressing that is already wanted', async () => {
    const service = await loaded([5]);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await service.toggle(5);

    expect(fetchMock).toHaveBeenLastCalledWith('/api/wantlist?releaseId=5', ownerRequest('DELETE'));
    expect(service.isWanted(5)).toBe(false);
  });

  it('keeps the button as it was when Discogs rejects the change', async () => {
    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });

    await service.toggle(5);

    expect(service.isWanted(5)).toBe(false);
  });

  it('becomes read-only when the server no longer accepts the key', async () => {
    const service = await loaded([1]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await service.toggle(5);

    expect(service.canEdit()).toBe(false);
    expect(service.isWanted(1)).toBe(true);
    expect(localStorage.getItem(KEY_STORAGE)).toBeNull();
  });

  it('retries loading on the next album after a failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const service = new WantlistService();
    await service.load();
    expect(service.failed()).toBe(true);

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ releaseIds: [9] }) });
    await service.load();
    expect(service.isWanted(9)).toBe(true);
  });

  it('ignores clicks before the wantlist has loaded', async () => {
    await new WantlistService().toggle(5);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
