import { readCatalog, writeCatalog, type CatalogRelease } from './catalog.repository.js';

const DISCOGS_API_URL = 'https://api.discogs.com';

type VercelRequest = { method?: string };
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
