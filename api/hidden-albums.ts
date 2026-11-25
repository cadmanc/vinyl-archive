import { hasOwnerKey } from './_owner-auth.js';
import { applyHiddenChange, updateOwnerFile, type HiddenAlbumsFile } from './_owner-data.js';

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

/** Hides (PUT) or unhides (DELETE) a missing album for everyone; only the owner may. */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const ownerKey = process.env.WANTLIST_OWNER_KEY?.trim();
  const githubToken = process.env.GITHUB_DATA_TOKEN?.trim();
  if (!ownerKey || !githubToken) {
    res.status(503).json({ error: 'Hidden albums storage is unavailable' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'PUT, DELETE').status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!hasOwnerKey(req, ownerKey)) {
    res.status(401).json({ error: 'Only the owner can hide albums' });
    return;
  }
  const masterId = Number(
    Array.isArray(req.query.masterId) ? req.query.masterId[0] : req.query.masterId,
  );
  if (!Number.isInteger(masterId) || masterId <= 0) {
    res.status(400).json({ error: 'A masterId is required' });
    return;
  }

  const hide = req.method === 'PUT';
  try {
    const saved = await updateOwnerFile<HiddenAlbumsFile>(
      'hidden-albums.json',
      githubToken,
      (current) => applyHiddenChange(current, masterId, hide),
      `${hide ? 'Hide' : 'Unhide'} album ${masterId}`,
    );
    res.status(200).json(saved);
  } catch (error) {
    console.error('Hidden albums could not be saved:', error);
    res.status(502).json({ error: 'Hidden albums could not be saved' });
  }
}
