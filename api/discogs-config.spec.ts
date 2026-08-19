import handler from './discogs-config';

describe('Discogs configuration API', () => {
  const createResponse = () => {
    const response = {} as { status: jest.Mock; setHeader: jest.Mock; json: jest.Mock };
    response.status = jest.fn().mockReturnValue(response);
    response.setHeader = jest.fn().mockReturnValue(response);
    response.json = jest.fn().mockReturnValue(response);
    return response;
  };

  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    delete process.env.DISCOGS_USERNAME;
    delete process.env.DISCOGS_TOKEN;
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('returns configured username without the server token', () => {
    process.env.DISCOGS_USERNAME = 'archive-user';
    process.env.DISCOGS_TOKEN = 'secret-token';
    const response = createResponse();

    handler({ method: 'GET' }, response);

    expect(response.json).toHaveBeenCalledWith({ configured: true, username: 'archive-user' });
    expect(JSON.stringify(response.json.mock.calls[0][0])).not.toContain('secret-token');
  });

  it('reports unavailable configuration when either server credential is missing', () => {
    process.env.DISCOGS_USERNAME = 'archive-user';
    const response = createResponse();

    handler({ method: 'GET' }, response);

    expect(response.json).toHaveBeenCalledWith({ configured: false, username: 'archive-user' });
  });
});
