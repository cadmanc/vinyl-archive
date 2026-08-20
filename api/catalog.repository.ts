import { get, put } from '@vercel/blob';
import { TextDecoder } from 'node:util';
import type { Release, ReleaseEnrichment } from '../src/app/shared/models/release.model';

export const CATALOG_PATHNAME = 'vinyl-archive/catalog.json';
export const CATALOG_SCHEMA_VERSION = 1;

export type CatalogRelease = Pick<Release, 'id' | 'instanceId' | 'basicInfo'>;

export interface CatalogDocument {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  updatedAt: string;
  releases: CatalogRelease[];
}

export function emptyCatalog(): CatalogDocument {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: new Date(0).toISOString(),
    releases: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCatalogRelease(value: unknown): value is CatalogRelease {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.instanceId !== 'number') {
    return false;
  }
  const basicInfo = value.basicInfo;
  return (
    isRecord(basicInfo) &&
    typeof basicInfo.title === 'string' &&
    Array.isArray(basicInfo.artists) &&
    basicInfo.artists.every((artist) => typeof artist === 'string') &&
    Array.isArray(basicInfo.formats) &&
    basicInfo.formats.every((format) => typeof format === 'string')
  );
}

function isCatalogDocument(value: unknown): value is CatalogDocument {
  return (
    isRecord(value) &&
    value.schemaVersion === CATALOG_SCHEMA_VERSION &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.releases) &&
    value.releases.every(isCatalogRelease)
  );
}

async function readBlobText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

export async function readCatalog(): Promise<CatalogDocument> {
  const blob = await get(CATALOG_PATHNAME, { access: 'private', useCache: false });
  if (!blob) return emptyCatalog();

  const storedDocument: unknown = JSON.parse(await readBlobText(blob.stream));
  if (!isCatalogDocument(storedDocument)) {
    throw new Error('Stored catalog is malformed');
  }
  return storedDocument;
}

export async function writeCatalog(releases: CatalogRelease[]): Promise<CatalogDocument> {
  const catalog: CatalogDocument = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    releases,
  };
  await put(CATALOG_PATHNAME, JSON.stringify(catalog), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
  return catalog;
}

export async function updateCatalogRelease(
  releaseId: number,
  enrichment: ReleaseEnrichment,
): Promise<CatalogDocument | null> {
  const catalog = await readCatalog();
  const release = catalog.releases.find((candidate) => candidate.id === releaseId);
  if (!release) return null;

  return writeCatalog(
    catalog.releases.map((candidate) =>
      candidate.id === releaseId
        ? { ...candidate, basicInfo: { ...candidate.basicInfo, ...enrichment } }
        : candidate,
    ),
  );
}
