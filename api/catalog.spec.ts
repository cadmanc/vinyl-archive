import handler from './catalog';
import { fetchCollection } from './catalog-sync';
import { readCatalog } from './catalog.repository';

jest.mock('./catalog.repository', () => ({
  CATALOG_SCHEMA_VERSION: 1,
  readCatalog: jest.fn(),
}));
jest.mock('./catalog-sync', () => ({ fetchCollection: jest.fn() }));

const readCatalogMock = jest.mocked(readCatalog);
const fetchCollectionMock = jest.mocked(fetchCollection);

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

  describe('when the private catalog cannot be read', () => {
    beforeEach(() => {
      readCatalogMock.mockRejectedValue(new Error('storage limit reached'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      delete process.env.DISCOGS_USERNAME;
      delete process.env.DISCOGS_TOKEN;
    });

    it('serves the collection straight from Discogs', async () => {
      process.env.DISCOGS_USERNAME = 'collector';
      process.env.DISCOGS_TOKEN = 'token';
      const releases = [
        { id: 1, instanceId: 2, basicInfo: { title: 'Bleach', artists: ['Nirvana'], formats: [] } },
      ];
      fetchCollectionMock.mockResolvedValue(releases);
      const response = createResponse();

      await handler({ method: 'GET' }, response);

      expect(fetchCollectionMock).toHaveBeenCalledWith('collector', 'token');
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ schemaVersion: 1, releases }),
      );
    });

    it('returns an error without Discogs configuration', async () => {
      const response = createResponse();

      await handler({ method: 'GET' }, response);

      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith({ error: 'Catalog could not be read' });
    });

    it('returns an error when Discogs fails too', async () => {
      process.env.DISCOGS_USERNAME = 'collector';
      process.env.DISCOGS_TOKEN = 'token';
      fetchCollectionMock.mockRejectedValue(new Error('down'));
      const response = createResponse();

      await handler({ method: 'GET' }, response);

      expect(response.status).toHaveBeenCalledWith(500);
    });
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
