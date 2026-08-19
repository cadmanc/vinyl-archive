import handler from './musicbrainz';

describe('MusicBrainz proxy', () => {
  const createResponse = () => {
    const response = {} as {
      status: jest.Mock;
      setHeader: jest.Mock;
      json: jest.Mock;
      send: jest.Mock;
    };
    response.status = jest.fn().mockReturnValue(response);
    response.setHeader = jest.fn().mockReturnValue(response);
    response.json = jest.fn().mockReturnValue(response);
    response.send = jest.fn().mockReturnValue(response);
    return response;
  };

  beforeEach(() => jest.restoreAllMocks());

  it('calls the official API with a meaningful server-side User-Agent', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
      text: async () => JSON.stringify({ 'release-groups': [] }),
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    const response = createResponse();

    await handler({ method: 'GET', query: { path: '/release-group/' } }, response);

    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'https://musicbrainz.org/ws/2/release-group/',
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          'User-Agent': 'VinylArchive/1.0 (https://github.com/cadmanc/vinyl-archive)',
        },
      }),
    );
    expect(response.send).toHaveBeenCalledWith({ 'release-groups': [] });
  });

  it('preserves upstream status and Retry-After', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 503,
      headers: { get: (name: string) => (name === 'retry-after' ? '4' : 'application/json') },
      text: async () => JSON.stringify({ error: 'busy' }),
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });
    const response = createResponse();

    await handler({ method: 'GET', query: { path: '/release-group/' } }, response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '4');
  });
});
