import handler from './wantlist';
import { hasOwnerKey } from './_owner-auth';

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
const savedFile = (releaseIds: number[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    sha: 'abc',
    content: Buffer.from(JSON.stringify({ releaseIds })).toString('base64'),
  }),
});

describe('wantlist API', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.DISCOGS_USERNAME = 'collector';
    process.env.DISCOGS_TOKEN = 'token';
    process.env.WANTLIST_OWNER_KEY = 'owner-secret';
    process.env.GITHUB_DATA_TOKEN = 'github-token';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.DISCOGS_USERNAME;
    delete process.env.DISCOGS_TOKEN;
    delete process.env.WANTLIST_OWNER_KEY;
    delete process.env.GITHUB_DATA_TOKEN;
  });

  it('adds a release on Discogs and to the saved wantlist', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce(savedFile([7]))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const response = createResponse();

    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: owner }, response);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL('https://api.discogs.com/users/collector/wants/42'),
      expect.objectContaining({ method: 'PUT' }),
    );
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe('https://api.github.com/repos/cadmanc/vinyl-archive/contents/wantlist.json');
    const body = JSON.parse(init.body);
    expect(body).toEqual(expect.objectContaining({ branch: 'owner-data', sha: 'abc' }));
    expect(JSON.parse(Buffer.from(body.content, 'base64').toString())).toEqual({
      releaseIds: [7, 42],
    });
    expect(response.body).toEqual({ releaseId: 42, wanted: true });
  });

  it('treats removing a release that is already gone as done', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(savedFile([]));
    const response = createResponse();

    await handler({ method: 'DELETE', query: { releaseId: '42' }, headers: owner }, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ releaseId: 42, wanted: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still succeeds when only the saved copy fails, since Discogs has the change', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    const response = createResponse();

    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: owner }, response);

    expect(response.statusCode).toBe(200);
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

  it('no longer reads the wantlist from Discogs', async () => {
    const response = createResponse();
    await handler({ method: 'GET', query: {}, headers: {} }, response);
    expect(response.statusCode).toBe(405);
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
    await handler({ method: 'PUT', query: { releaseId: '42' }, headers: owner }, response);
    expect(response.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('hasOwnerKey', () => {
  it('only accepts the exact key', () => {
    expect(hasOwnerKey({ headers: owner }, 'owner-secret')).toBe(true);
    expect(hasOwnerKey({ headers: owner }, 'owner-secret-2')).toBe(false);
    expect(hasOwnerKey({ headers: {} }, 'owner-secret')).toBe(false);
  });
});
