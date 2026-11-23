const DISCOGS_API_URL = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'VinylArchive/1.0';
const MAX_PAGES = 20;

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

interface WantsPage {
  pagination: { pages: number };
  wants: Array<{ id: number }>;
}

function header(req: VercelRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The site has no sign-in, so changes are only accepted from pages served by this site.
 * Browsers always send Origin on these requests and other sites can't forge it.
 */
export function isSameOrigin(req: VercelRequest): boolean {
  const origin = header(req, 'origin');
  const host = header(req, 'x-forwarded-host') ?? header(req, 'host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function discogs(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, DISCOGS_API_URL), {
    ...init,
    headers: {
      Accept: 'application/json',
      'User-Agent': DISCOGS_USER_AGENT,
      Authorization: `Discogs token=${token}`,
    },
  });
}

async function wantedReleaseIds(username: string, token: string): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await discogs(
      `/users/${encodeURIComponent(username)}/wants?per_page=100&page=${page}`,
      token,
    );
    if (!response.ok) throw new Error(`Discogs wantlist request failed with ${response.status}`);
    const data = (await response.json()) as WantsPage;
    ids.push(...data.wants.map((want) => want.id));
    if (page >= data.pagination.pages) break;
  }
  return ids;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const username = process.env.DISCOGS_USERNAME?.trim();
  const token = process.env.DISCOGS_TOKEN?.trim();
  if (!username || !token) {
    res.status(503).json({ error: 'Discogs server configuration is unavailable' });
    return;
  }

  if (req.method === 'GET') {
    try {
      res
        .setHeader('Cache-Control', 'no-store')
        .status(200)
        .json({ releaseIds: await wantedReleaseIds(username, token) });
    } catch {
      res.status(502).json({ error: 'Discogs wantlist could not be read' });
    }
    return;
  }

  if (req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, PUT, DELETE').status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!isSameOrigin(req)) {
    res.status(403).json({ error: 'Wantlist changes are only accepted from this site' });
    return;
  }
  const releaseId = Number(
    Array.isArray(req.query.releaseId) ? req.query.releaseId[0] : req.query.releaseId,
  );
  if (!Number.isInteger(releaseId) || releaseId <= 0) {
    res.status(400).json({ error: 'A releaseId is required' });
    return;
  }

  try {
    const response = await discogs(
      `/users/${encodeURIComponent(username)}/wants/${releaseId}`,
      token,
      { method: req.method },
    );
    // Removing something already gone, or adding something already there, is fine.
    const settled = response.ok || (req.method === 'DELETE' && response.status === 404);
    if (!settled) throw new Error(`Discogs wantlist update failed with ${response.status}`);
    res.status(200).json({ releaseId, wanted: req.method === 'PUT' });
  } catch {
    res.status(502).json({ error: 'Discogs wantlist could not be updated' });
  }
}
