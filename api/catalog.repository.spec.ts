import { get, put } from '@vercel/blob';
import { ReadableStream } from 'node:stream/web';
import {
  CATALOG_PATHNAME,
  emptyCatalog,
  readCatalog,
  updateCatalogRelease,
  writeCatalog,
} from './catalog.repository';

jest.mock('@vercel/blob', () => ({
  get: jest.fn(),
  put: jest.fn(),
}));

const getMock = jest.mocked(get);
const putMock = jest.mocked(put);

function streamOf(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(value, (character) => character.charCodeAt(0)));
      controller.close();
    },
  });
}

describe('catalog repository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty version 1 catalog when the blob does not exist', async () => {
    getMock.mockResolvedValue(null);

    await expect(readCatalog()).resolves.toEqual(emptyCatalog());
    expect(getMock).toHaveBeenCalledWith(CATALOG_PATHNAME, {
      access: 'private',
      useCache: false,
    });
  });

  it('rejects malformed stored JSON and documents', async () => {
    getMock.mockResolvedValue({ stream: streamOf('{"schemaVersion":2}') } as never);
    await expect(readCatalog()).rejects.toThrow('Stored catalog is malformed');

    getMock.mockResolvedValue({ stream: streamOf('{not-json') } as never);
    await expect(readCatalog()).rejects.toThrow(SyntaxError);
  });

  it('writes the fixed private pathname with a fresh timestamp and overwrite enabled', async () => {
    putMock.mockResolvedValue({} as never);
    const releases = [
      {
        id: 123,
        instanceId: 456,
        basicInfo: { title: 'Album', artists: ['Artist'], formats: ['LP'] },
      },
    ];

    const result = await writeCatalog(releases);

    expect(result).toEqual({
      schemaVersion: 1,
      updatedAt: expect.any(String),
      releases,
    });
    expect(putMock).toHaveBeenCalledWith(
      CATALOG_PATHNAME,
      JSON.stringify(result),
      expect.objectContaining({
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      }),
    );
  });

  it('merges enrichment without replacing the server catalog release', async () => {
    getMock.mockResolvedValue({
      stream: streamOf(
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: '',
          releases: [
            {
              id: 123,
              instanceId: 456,
              basicInfo: { title: 'Album', artists: ['Artist'], formats: ['LP'] },
            },
          ],
        }),
      ),
    } as never);
    putMock.mockResolvedValue({} as never);

    await updateCatalogRelease(123, {
      detailsFetched: true,
      trackCount: 1,
      tracklist: [{ position: 'A1', title: 'Track' }],
      originalYear: 1968,
    });

    expect(putMock).toHaveBeenCalledWith(
      CATALOG_PATHNAME,
      expect.stringContaining('"detailsFetched":true'),
      expect.anything(),
    );
    expect(putMock).toHaveBeenCalledWith(
      CATALOG_PATHNAME,
      expect.stringContaining('"originalYear":1968'),
      expect.anything(),
    );
  });
});
