import { hasOwnerKey } from './_owner-auth.js';
import { sortedIds, updateOwnerFile, type WantlistFile } from './_owner-data.js';

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

/**
 * Adds or removes a pressing on the owner's Discogs wantlist, then updates the saved copy
 * on GitHub that the site reads. Changes made on Discogs itself arrive with the daily job.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const username = process.env.DISCOGS_USERNAME?.trim();
  const token = process.env.DISCOGS_TOKEN?.trim();
  const ownerKey = process.env.WANTLIST_OWNER_KEY?.trim();
  const githubToken = process.env.GITHUB_DATA_TOKEN?.trim();
  if (!username || !token || !ownerKey) {
    res.status(503).json({ error: 'Discogs server configuration is unavailable' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'PUT, DELETE').status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!hasOwnerKey(req, ownerKey)) {
    res.status(401).json({ error: 'Only the owner can change the wantlist' });
    return;
  }
  const releaseId = Number(
    Array.isArray(req.query.releaseId) ? req.query.releaseId[0] : req.query.releaseId,
  );
  if (!Number.isInteger(releaseId) || releaseId <= 0) {
    res.status(400).json({ error: 'A releaseId is required' });
    return;
  }
  const wanted = req.method === 'PUT';

  try {
    const response = await fetch(
      new URL(`/users/${encodeURIComponent(username)}/wants/${releaseId}`, DISCOGS_API_URL),
      {
        method: req.method,
        headers: {
          Accept: 'application/json',
          'User-Agent': DISCOGS_USER_AGENT,
          Authorization: `Discogs token=${token}`,
        },
      },
    );
    // Removing something already gone, or adding something already there, is fine.
    const settled = response.ok || (!wanted && response.status === 404);
    if (!settled) throw new Error(`Discogs wantlist update failed with ${response.status}`);
  } catch {
    res.status(502).json({ error: 'Discogs wantlist could not be updated' });
    return;
  }

  if (githubToken) {
    try {
      await updateOwnerFile<WantlistFile>(
        'wantlist.json',
        githubToken,
        (current) => {
          const ids = new Set(current?.releaseIds ?? []);
          if (wanted) ids.add(releaseId);
          else ids.delete(releaseId);
          return { releaseIds: sortedIds(ids) };
        },
        `${wanted ? 'Want' : 'Unwant'} release ${releaseId}`,
      );
    } catch (error) {
      // Discogs has the change; the daily job brings the saved copy up to date.
      console.error('Saved wantlist could not be updated:', error);
    }
  }
  res.status(200).json({ releaseId, wanted });
}
