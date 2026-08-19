import handler from './discogs';
import apiPackage from './package.json';

describe('Discogs proxy', () => {
  it('loads under the Vercel ESM module boundary', () => {
    expect(apiPackage.type).toBe('module');
    expect(handler).toEqual(expect.any(Function));
  });

  const createUpstreamResponse = (body: unknown, status: number) => ({
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body),
  });

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

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  function mockFetch(response: object): jest.Mock {
    const fetchMock = jest.fn().mockResolvedValue(response);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
      writable: true,
    });
    return fetchMock;
  }

  it.each([
    ['/releases/123', { id: 123 }],
    ['/masters/456', { id: 456, year: 1980 }],
  ])('forwards %s through Discogs', async (path, body) => {
    const fetchMock = mockFetch(createUpstreamResponse(body, 200));
    const response = createResponse();

    await handler(
      {
        method: 'GET',
        query: { path },
        headers: { authorization: 'Discogs token=secret-token' },
      },
      response,
    );

    expect(fetchMock.mock.calls[0][0].toString()).toBe(`https://api.discogs.com${path}`);
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Discogs token=secret-token',
          'User-Agent': 'VinylArchive/1.0',
        }),
      }),
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(body);
  });

  it.each([429, 500, 502, 503, 504])('preserves upstream status %s', async (status) => {
    mockFetch(createUpstreamResponse({ message: 'upstream failure' }, status));
    const response = createResponse();

    await handler({ method: 'GET', query: { path: '/masters/456' }, headers: {} }, response);

    expect(response.status).toHaveBeenCalledWith(status);
  });

  it('does not expose credentials in logs', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockFetch(createUpstreamResponse({}, 200));
    const response = createResponse();

    await handler(
      {
        method: 'GET',
        query: { path: '/releases/123' },
        headers: { authorization: 'Discogs token=secret-token' },
      },
      response,
    );

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('secret-token'));
  });
});
