import handler from './collection-value';

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

describe('collection value API', () => {
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

  it('returns the low, typical and high estimates for the owner', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ minimum: '$1,000.00', median: '$2,000.00', maximum: '$3,000.00' }),
    });
    const response = createResponse();

    await handler({ method: 'GET', query: {}, headers: owner }, response);

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.discogs.com/users/collector/collection/value',
    );
    expect(response.body).toEqual({ low: '$1,000.00', typical: '$2,000.00', high: '$3,000.00' });
  });

  it('keeps the value from visitors', async () => {
    const response = createResponse();
    await handler({ method: 'GET', query: {}, headers: {} }, response);
    expect(response.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports Discogs failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const response = createResponse();
    await handler({ method: 'GET', query: {}, headers: owner }, response);
    expect(response.statusCode).toBe(502);
  });
});
