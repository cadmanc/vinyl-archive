import handler from './catalog-sync';
import { readCatalog, writeCatalog } from './catalog.repository';

jest.mock('./catalog.repository', () => ({
  readCatalog: jest.fn(),
  writeCatalog: jest.fn(),
}));

const readCatalogMock = jest.mocked(readCatalog);
const writeCatalogMock = jest.mocked(writeCatalog);

describe('catalog sync API', () => {
  const response = () => {
    const result = {} as { status: jest.Mock; setHeader: jest.Mock; json: jest.Mock };
    result.status = jest.fn().mockReturnValue(result);
    result.setHeader = jest.fn().mockReturnValue(result);
    result.json = jest.fn().mockReturnValue(result);
    return result;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DISCOGS_USERNAME = 'server-user';
    process.env.DISCOGS_TOKEN = 'server-token';
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        pagination: { pages: 1 },
        releases: [
          {
            instance_id: 10,
            date_added: '2026-08-20T00:00:00Z',
            basic_information: {
              id: 123,
              title: 'Server Album',
              artists: [{ name: 'Server Artist' }],
              formats: [{ name: 'Vinyl', qty: '1' }],
              labels: [],
            },
          },
        ],
      }),
    });
    readCatalogMock.mockResolvedValue({ schemaVersion: 1, updatedAt: '', releases: [] });
    writeCatalogMock.mockResolvedValue({ schemaVersion: 1, updatedAt: '', releases: [] });
  });

  afterEach(() => {
    delete process.env.DISCOGS_USERNAME;
    delete process.env.DISCOGS_TOKEN;
  });

  it('derives Blob mutation from the configured server Discogs account', async () => {
    const res = response();

    await handler({ method: 'POST' }, res);

    expect(writeCatalogMock).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 123,
        basicInfo: expect.objectContaining({ title: 'Server Album' }),
      }),
    ]);
  });

  it('rejects browser-supplied catalog JSON', async () => {
    const res = response();

    await handler({ method: 'POST', body: { releases: [{ id: 999 }] } } as never, res);

    expect(writeCatalogMock).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 999 })]),
    );
  });

  it('never returns server secrets', async () => {
    const res = response();

    await handler({ method: 'POST' }, res);

    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ DISCOGS_TOKEN: expect.anything() }),
    );
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ BLOB_READ_WRITE_TOKEN: expect.anything() }),
    );
  });
});
