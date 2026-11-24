import { hasOwnerKey } from './_owner-auth.js';

const DISCOGS_API_URL = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'VinylArchive/1.0';

type VercelRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

interface DiscogsCollectionValue {
  minimum: string;
  median: string;
  maximum: string;
}

/** Discogs' estimate of what the collection would sell for; only the owner can see it. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
    return;
  }
  const username = process.env.DISCOGS_USERNAME?.trim();
  const token = process.env.DISCOGS_TOKEN?.trim();
  const ownerKey = process.env.WANTLIST_OWNER_KEY?.trim();
  if (!username || !token || !ownerKey) {
    res.status(503).json({ error: 'Discogs server configuration is unavailable' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!hasOwnerKey(req, ownerKey)) {
    res.status(401).json({ error: 'Only the owner can see the collection value' });
    return;
  }

  try {
    const response = await fetch(
      new URL(`/users/${encodeURIComponent(username)}/collection/value`, DISCOGS_API_URL),
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': DISCOGS_USER_AGENT,
          Authorization: `Discogs token=${token}`,
        },
      },
    );
    if (!response.ok) throw new Error(`Discogs collection value failed with ${response.status}`);
    const value = (await response.json()) as DiscogsCollectionValue;
    res.status(200).json({ low: value.minimum, typical: value.median, high: value.maximum });
  } catch {
    res.status(502).json({ error: 'Discogs collection value could not be read' });
  }
}
