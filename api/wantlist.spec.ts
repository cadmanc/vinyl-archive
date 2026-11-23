import handler, { isSameOrigin } from './wantlist';

const createResponse = () => {
  const response = { statusCode: 0, body: undefined as unknown } as {
    statusCode: number;
    body: unknown;
    status: jest.Mock;
    setHeader: jest.Mock;
    json: jest.Mock;
  };
  response.status = jest.fn((code: number) => {
    response.statusCode = code;
    return response;
  });
  response.setHeader = jest.fn(() => response);
  response.json = jest.fn((body: unknown) => {
    response.body = body;
    return response;
  });
  return response;
};

const sameSite = { origin: 'https://records.psamera.com', host: 'records.psamera.com' };

describe('wantlist API', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.DISCOGS_USERNAME = 'collector';
    process.env.DISCOGS_TOKEN = 'token';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.DISCOGS_USERNAME;
    delete process.env.DISCOGS_TOKEN;
  });

  it('lists every wanted release across pages', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pagination: { pages: 2 }, wants: [{ id: 1 }, { id: 2 }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pagination: { pages: 2 }, wants: [{ id: 3 }] }),
      });
    const response = createResponse();

    await handler({ method: 'GET', query: {}, headers: {} }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ releaseIds: [1, 2, 3] });
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/users/collector/wants?per_page=100&page=2',
    );
  });

  it('adds a release from this site', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const response = createResponse();

    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: sameSite }, response);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.discogs.com/users/collector/wants/42'),
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(response.body).toEqual({ releaseId: 42, wanted: true });
  });

  it('treats removing a release that is already gone as done', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const response = createResponse();

    await handler({ method: 'DELETE', query: { releaseId: '42' }, headers: sameSite }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ releaseId: 42, wanted: false });
  });

  it('rejects changes from other sites', async () => {
    const response = createResponse();

    await handler(
      {
        method: 'PUT',
        query: { releaseId: '42' },
        headers: { origin: 'https://example.com', host: 'records.psamera.com' },
      },
      response,
    );

    expect(response.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a release id', async () => {
    const response = createResponse();
    await handler({ method: 'PUT', query: {}, headers: sameSite }, response);
    expect(response.statusCode).toBe(400);
  });

  it('reports Discogs failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const response = createResponse();
    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: sameSite }, response);
    expect(response.statusCode).toBe(502);
  });

  it('needs the Discogs configuration', async () => {
    delete process.env.DISCOGS_TOKEN;
    const response = createResponse();
    await handler({ method: 'GET', query: {}, headers: {} }, response);
    expect(response.statusCode).toBe(503);
  });
});

describe('isSameOrigin', () => {
  it('requires an Origin header matching the host', () => {
    expect(isSameOrigin({ query: {}, headers: sameSite })).toBe(true);
    expect(isSameOrigin({ query: {}, headers: { host: 'records.psamera.com' } })).toBe(false);
    expect(isSameOrigin({ query: {}, headers: { origin: 'not a url', host: 'a' } })).toBe(false);
  });
});
