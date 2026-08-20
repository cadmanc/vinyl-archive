import handler from './catalog';
import { readCatalog } from './catalog.repository';

jest.mock('./catalog.repository', () => ({
  readCatalog: jest.fn(),
}));

const readCatalogMock = jest.mocked(readCatalog);

describe('catalog API', () => {
  const createResponse = () => {
    const response = {} as {
      status: jest.Mock;
      setHeader: jest.Mock;
      json: jest.Mock;
    };
    response.status = jest.fn().mockReturnValue(response);
    response.setHeader = jest.fn().mockReturnValue(response);
    response.json = jest.fn().mockReturnValue(response);
    return response;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the server-side catalog for GET', async () => {
    const catalog = { schemaVersion: 1, updatedAt: '2026-08-19T00:00:00.000Z', releases: [] };
    readCatalogMock.mockResolvedValue(catalog);
    const response = createResponse();

    await handler({ method: 'GET' }, response);

    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(catalog);
  });

  it('does not expose a write method', async () => {
    const response = createResponse();

    await handler({ method: 'POST' }, response);

    expect(response.setHeader).toHaveBeenCalledWith('Allow', 'GET');
    expect(response.status).toHaveBeenCalledWith(405);
    expect(response.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('returns an error when the private catalog cannot be read', async () => {
    readCatalogMock.mockRejectedValue(new Error('malformed'));
    const response = createResponse();

    await handler({ method: 'GET' }, response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: 'Catalog could not be read' });
  });

  it('does not issue a write authorization cookie', async () => {
    readCatalogMock.mockResolvedValue({
      schemaVersion: 1,
      updatedAt: '2026-08-20T00:00:00.000Z',
      releases: [],
    });
    const response = createResponse();

    await handler({ method: 'GET' }, response);

    expect(response.setHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything());
  });
});
