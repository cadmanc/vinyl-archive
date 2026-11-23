import { WantlistService } from './wantlist.service';

describe('WantlistService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  const loaded = async (releaseIds: number[]) => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ releaseIds }) });
    const service = new WantlistService();
    await service.load();
    return service;
  };

  it('loads the wantlist once for the visit', async () => {
    const service = await loaded([1, 2]);
    await service.load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(service.isWanted(1)).toBe(true);
    expect(service.isWanted(3)).toBe(false);
  });

  it('adds a pressing that is not wanted yet', async () => {
    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await service.toggle(5);

    expect(fetchMock).toHaveBeenLastCalledWith('/api/wantlist?releaseId=5', { method: 'PUT' });
    expect(service.isWanted(5)).toBe(true);
    expect(service.isPending(5)).toBe(false);
  });

  it('removes a pressing that is already wanted', async () => {
    const service = await loaded([5]);
    fetchMock.mockResolvedValueOnce({ ok: true });

    await service.toggle(5);

    expect(fetchMock).toHaveBeenLastCalledWith('/api/wantlist?releaseId=5', { method: 'DELETE' });
    expect(service.isWanted(5)).toBe(false);
  });

  it('keeps the button as it was when Discogs rejects the change', async () => {
    const service = await loaded([]);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });

    await service.toggle(5);

    expect(service.isWanted(5)).toBe(false);
  });

  it('retries loading on the next album after a failure', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502 });
    const service = new WantlistService();
    await service.load();
    expect(service.failed()).toBe(true);

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ releaseIds: [9] }) });
    await service.load();
    expect(service.isWanted(9)).toBe(true);
  });

  it('picks up wantlist changes made on Discogs when the tab is shown again', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const service = await loaded([]);

    await service.refreshIfStale();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_000 + 31_000);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ releaseIds: [5] }) });
    await service.refreshIfStale();
    expect(service.isWanted(5)).toBe(true);
    now.mockRestore();
  });

  it('does not fetch on tab changes before the wantlist is first needed', async () => {
    await new WantlistService().refreshIfStale();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores clicks before the wantlist has loaded', async () => {
    await new WantlistService().toggle(5);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
