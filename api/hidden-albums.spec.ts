import handler from './hidden-albums';
import { autoHideSecondaryAlbums, applyHiddenChange } from './_owner-data';

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
const savedFile = (masterIds: number[]) => ({
  ok: true,
  status: 200,
  json: async () => ({
    sha: 'abc',
    content: Buffer.from(JSON.stringify({ masterIds })).toString('base64'),
  }),
});
const savedContent = (fetchMock: jest.Mock, call: number) =>
  JSON.parse(
    Buffer.from(JSON.parse(fetchMock.mock.calls[call][1].body).content, 'base64').toString(),
  );

describe('hidden albums API', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.WANTLIST_OWNER_KEY = 'owner-secret';
    process.env.GITHUB_DATA_TOKEN = 'github-token';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.WANTLIST_OWNER_KEY;
    delete process.env.GITHUB_DATA_TOKEN;
  });

  it('hides an album for everyone by saving it on the owner-data branch', async () => {
    fetchMock.mockResolvedValueOnce(savedFile([5])).mockResolvedValueOnce({ ok: true });
    const response = createResponse();

    await handler({ method: 'PUT', query: { masterId: '42' }, headers: owner }, response);

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/cadmanc/vinyl-archive/contents/hidden-albums.json?ref=owner-data',
    );
    expect(savedContent(fetchMock, 1)).toEqual({ masterIds: [5, 42] });
    expect(response.body).toEqual({ masterIds: [5, 42] });
  });

  it('creates the file the first time an album is hidden', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce({ ok: true });
    const response = createResponse();

    await handler({ method: 'PUT', query: { masterId: '42' }, headers: owner }, response);

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).sha).toBeUndefined();
    expect(response.body).toEqual({ masterIds: [42] });
  });

  it('unhides an album and remembers it so EPs stay revealed', async () => {
    fetchMock.mockResolvedValueOnce(savedFile([5, 42])).mockResolvedValueOnce({ ok: true });
    const response = createResponse();

    await handler({ method: 'DELETE', query: { masterId: '42' }, headers: owner }, response);

    expect(response.body).toEqual({ masterIds: [5], revealedMasterIds: [42] });
  });

  it('tries again when another change was saved at the same moment', async () => {
    fetchMock
      .mockResolvedValueOnce(savedFile([5]))
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce(savedFile([5, 6]))
      .mockResolvedValueOnce({ ok: true });
    const response = createResponse();

    await handler({ method: 'PUT', query: { masterId: '42' }, headers: owner }, response);

    expect(savedContent(fetchMock, 3)).toEqual({ masterIds: [5, 6, 42] });
    expect(response.statusCode).toBe(200);
  });

  it('refuses visitors', async () => {
    const response = createResponse();
    await handler({ method: 'PUT', query: { masterId: '42' }, headers: {} }, response);
    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs the GitHub token to save', async () => {
    delete process.env.GITHUB_DATA_TOKEN;
    const response = createResponse();
    await handler({ method: 'PUT', query: { masterId: '42' }, headers: owner }, response);
    expect(response.statusCode).toBe(503);
  });

  it('reports GitHub failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const response = createResponse();
    await handler({ method: 'PUT', query: { masterId: '42' }, headers: owner }, response);
    expect(response.statusCode).toBe(502);
  });
});

describe('auto-hide EPs and compilations', () => {
  it('hides new secondary albums without re-hiding ones the owner revealed', () => {
    const current = applyHiddenChange({ masterIds: [1] }, 2, false);
    expect(current).toEqual({ masterIds: [1], revealedMasterIds: [2] });
    expect(autoHideSecondaryAlbums(current, [2, 3, 4])).toEqual({
      masterIds: [1, 3, 4],
      revealedMasterIds: [2],
    });
  });
});
