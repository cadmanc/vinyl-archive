import { CollectionValueService } from './collection-value.service';

describe('CollectionValueService', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => localStorage.clear());

  it('loads the value once per visit on the owner device', async () => {
    localStorage.setItem('wantlist-owner-key', 'owner-secret');
    const value = { low: '$1', typical: '$2', high: '$3' };
    fetchMock.mockResolvedValue({ ok: true, json: async () => value });
    const service = new CollectionValueService();

    await service.load();
    await service.load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/collection-value', {
      headers: { 'X-Owner-Key': 'owner-secret' },
    });
    expect(service.value()).toEqual(value);
  });

  it('makes no request for visitors', async () => {
    const service = new CollectionValueService();
    await service.load();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(service.value()).toBeNull();
  });

  it('shows nothing when Discogs fails', async () => {
    localStorage.setItem('wantlist-owner-key', 'owner-secret');
    fetchMock.mockResolvedValue({ ok: false, status: 502 });
    const service = new CollectionValueService();
    await service.load();
    expect(service.value()).toBeNull();
  });
});
