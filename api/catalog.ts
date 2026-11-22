import { fetchCollection } from './catalog-sync.js';
import { CATALOG_SCHEMA_VERSION, readCatalog } from './catalog.repository.js';

type VercelRequest = {
  method?: string;
};

type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    res
      .setHeader('Content-Type', 'application/json')
      .status(200)
      .json(await readCatalog());
    return;
  } catch (error) {
    console.error('Stored catalog could not be read; using Discogs directly:', error);
  }

  // Storage can be unavailable (for example after a plan limit); the collection itself
  // still comes straight from Discogs so additions and removals keep showing up.
  const username = process.env.DISCOGS_USERNAME?.trim();
  const token = process.env.DISCOGS_TOKEN?.trim();
  if (!username || !token) {
    res.status(500).json({ error: 'Catalog could not be read' });
    return;
  }
  try {
    res
      .setHeader('Content-Type', 'application/json')
      .status(200)
      .json({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        releases: await fetchCollection(username, token),
      });
  } catch {
    res.status(500).json({ error: 'Catalog could not be read' });
  }
}
