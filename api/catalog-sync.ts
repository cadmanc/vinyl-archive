import {
  readCatalog,
  updateCatalogRelease,
  writeCatalog,
  type CatalogRelease,
} from './catalog.repository.js';
import type { ReleaseEnrichment } from '../src/app/shared/models/release.model.js';

const DISCOGS_API_URL = 'https://api.discogs.com';

type VercelRequest = { method?: string; body?: unknown };
type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

type DiscogsCollectionResponse = {
  pagination: { pages: number };
  releases: Array<{
    instance_id: number;
    date_added: string;
    basic_information: {
      id: number;
      title: string;
      artists: Array<{ name: string }>;
      year?: number;
      master_id?: number;
      formats: Array<{ name: string; qty: string; descriptions?: string[] }>;
      thumb?: string;
      cover_image?: string;
      labels: Array<{ name: string; catno?: string }>;
      genres?: string[];
      styles?: string[];
    };
  }>;
};

function formatRelease(item: DiscogsCollectionResponse['releases'][number]): CatalogRelease {
  const info = item.basic_information;
  return {
    id: info.id,
    instanceId: item.instance_id,
    basicInfo: {
      title: info.title,
      artists: info.artists.map((artist) => artist.name),
      year: info.year || undefined,
      masterId: info.master_id || undefined,
      formats: info.formats.map(
        (format) =>
          `${format.name}${format.descriptions?.length ? ` (${format.descriptions.join(', ')})` : ''}`,
      ),
      thumb: info.thumb,
      coverImage: info.cover_image,
      labels: info.labels.map((label) => label.name),
      label: info.labels[0]?.name,
      catalogNumber: info.labels[0]?.catno,
      genres: info.genres,
      styles: info.styles,
    },
  };
}

async function fetchCollectionPage(username: string, token: string, page: number) {
  const url = new URL(
    `/users/${encodeURIComponent(username)}/collection/folders/0/releases`,
    DISCOGS_API_URL,
  );
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', '100');
  const response = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Discogs token=${token}` },
  });
  if (!response.ok) throw new Error('Discogs collection request failed');
  return (await response.json()) as DiscogsCollectionResponse;
}

const ENRICHMENT_KEYS = new Set<keyof ReleaseEnrichment>([
  'masterId',
  'originalYear',
  'year',
  'label',
  'catalogNumber',
  'format',
  'tracklist',
  'detailsFetched',
  'trackCount',
  'totalRuntimeSeconds',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEnrichment(value: unknown): value is ReleaseEnrichment {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !ENRICHMENT_KEYS.has(key as keyof ReleaseEnrichment))
  ) {
    return false;
  }
  if (value.detailsFetched !== undefined && value.detailsFetched !== true) return false;
  if (value.detailsFetched === undefined && value.originalYear === undefined) return false;
  if (value.masterId !== undefined && (!Number.isInteger(value.masterId) || value.masterId <= 0)) {
    return false;
  }
  if (
    value.originalYear !== undefined &&
    (!Number.isInteger(value.originalYear) || value.originalYear < 1800)
  ) {
    return false;
  }
  if (value.year !== undefined && (!Number.isInteger(value.year) || value.year < 1800)) {
    return false;
  }
  if (
    value.trackCount !== undefined &&
    (!Number.isInteger(value.trackCount) || value.trackCount < 0)
  ) {
    return false;
  }
  if (
    value.totalRuntimeSeconds !== undefined &&
    (!Number.isInteger(value.totalRuntimeSeconds) || value.totalRuntimeSeconds < 0)
  ) {
    return false;
  }
  if (
    (value.label !== undefined && typeof value.label !== 'string') ||
    (value.catalogNumber !== undefined && typeof value.catalogNumber !== 'string') ||
    (value.format !== undefined && typeof value.format !== 'string')
  ) {
    return false;
  }
  if (
    value.detailsFetched === true &&
    (!Array.isArray(value.tracklist) || value.trackCount === undefined)
  ) {
    return false;
  }
  return (
    value.tracklist === undefined ||
    value.tracklist.every(
      (track) =>
        isRecord(track) &&
        typeof track.position === 'string' &&
        typeof track.title === 'string' &&
        (track.duration === undefined || typeof track.duration === 'string') &&
        (track.type === undefined || typeof track.type === 'string'),
    )
  );
}

function normalizeEnrichmentRequest(body: unknown): unknown {
  if (!isRecord(body) || !isRecord(body.enrichment) || body.enrichment.year !== 0) {
    return body;
  }

  const { year: _unknownYear, ...enrichment } = body.enrichment;
  return { ...body, enrichment };
}

function isEnrichmentRequest(
  body: unknown,
): body is { releaseId: number; enrichment: ReleaseEnrichment } {
  return (
    isRecord(body) &&
    Number.isInteger(body.releaseId) &&
    body.releaseId > 0 &&
    isEnrichment(body.enrichment)
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST').status(405).json({ error: 'Method not allowed' });
    return;
  }

  const username = process.env.DISCOGS_USERNAME?.trim();
  const token = process.env.DISCOGS_TOKEN?.trim();
  if (!username || !token) {
    res.status(503).json({ error: 'Discogs server configuration is unavailable' });
    return;
  }

  try {
    const normalizedBody = normalizeEnrichmentRequest(req.body);
    if (isEnrichmentRequest(normalizedBody)) {
      const catalog = await readCatalog();
      if (!catalog.releases.some((release) => release.id === normalizedBody.releaseId)) {
        res.status(404).json({ error: 'Release is not in the server catalog' });
        return;
      }
      await updateCatalogRelease(normalizedBody.releaseId, normalizedBody.enrichment);
      res.status(200).json({ ok: true });
      return;
    }
    if (req.body !== undefined) {
      res.status(400).json({ error: 'Invalid catalog enrichment request' });
      return;
    }

    const existing = await readCatalog();
    const firstPage = await fetchCollectionPage(username, token, 1);
    const items = [...firstPage.releases];
    for (let page = 2; page <= firstPage.pagination.pages; page++) {
      items.push(...(await fetchCollectionPage(username, token, page)).releases);
    }

    const existingById = new Map(existing.releases.map((release) => [release.id, release]));
    const releases = items.map((item) => {
      const serverRelease = formatRelease(item);
      const persisted = existingById.get(serverRelease.id);
      return persisted
        ? { ...serverRelease, basicInfo: { ...serverRelease.basicInfo, ...persisted.basicInfo } }
        : serverRelease;
    });
    await writeCatalog(releases);
    res.status(200).json({ ok: true });
  } catch {
    res.status(502).json({ error: 'Catalog synchronization failed' });
  }
}
