import handler, { hasOwnerKey } from './wantlist';

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

const owner = { 'x-owner-key': 'owner-secret' };

describe('wantlist API', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.DISCOGS_USERNAME = 'collector';
    process.env.DISCOGS_TOKEN = 'token';
    process.env.WANTLIST_OWNER_KEY = 'owner-secret';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    delete process.env.DISCOGS_USERNAME;
    delete process.env.DISCOGS_TOKEN;
    delete process.env.WANTLIST_OWNER_KEY;
  });

  it('lists every wanted release across pages for anyone', async () => {
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

  it('adds a release for the owner', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 201 });
    const response = createResponse();

    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: owner }, response);

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.discogs.com/users/collector/wants/42'),
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(response.body).toEqual({ releaseId: 42, wanted: true });
  });

  it('treats removing a release that is already gone as done', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const response = createResponse();

    await handler({ method: 'DELETE', query: { releaseId: '42' }, headers: owner }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ releaseId: 42, wanted: false });
  });

  it.each([
    ['without a key', {}],
    ['with the wrong key', { 'x-owner-key': 'guess' }],
  ])('refuses changes from visitors %s', async (_, headers) => {
    for (const method of ['PUT', 'DELETE']) {
      const response = createResponse();
      await handler({ method, query: { releaseId: '42' }, headers }, response);
      expect(response.statusCode).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a release id', async () => {
    const response = createResponse();
    await handler({ method: 'PUT', query: {}, headers: owner }, response);
    expect(response.statusCode).toBe(400);
  });

  it('reports Discogs failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const response = createResponse();
    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: owner }, response);
    expect(response.statusCode).toBe(502);
  });

  it.each(['DISCOGS_TOKEN', 'WANTLIST_OWNER_KEY'])('needs %s to be configured', async (name) => {
    delete process.env[name];
    const response = createResponse();
    await handler({ method: 'GET', query: {}, headers: owner }, response);
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hasOwnerKey', () => {
  it('only accepts the exact key', () => {
    expect(hasOwnerKey({ query: {}, headers: owner }, 'owner-secret')).toBe(true);
    expect(hasOwnerKey({ query: {}, headers: owner }, 'owner-secret-2')).toBe(false);
    expect(hasOwnerKey({ query: {}, headers: {} }, 'owner-secret')).toBe(false);
  });
});
