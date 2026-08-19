const DISCOGS_API_URL = 'https://api.discogs.com';
const DISCOGS_USER_AGENT = 'VinylArchive/1.0';
const REQUEST_TIMEOUT_MS = 10_000;
const FORWARDED_HEADERS = [
  'retry-after',
  'x-discogs-ratelimit',
  'x-discogs-ratelimit-remaining',
  'x-discogs-ratelimit-used',
];

type VercelRequest = {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
};

type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
  send: (body: unknown) => VercelResponse;
};

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function responseBody(contentType: string | null, body: string): unknown {
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
    }
  }
  return body;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
    return;
  }

  const path = queryValue(req.query.path);
  if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    res.status(400).json({ error: 'A relative Discogs API path is required' });
    return;
  }

  const serverToken = process.env.DISCOGS_TOKEN?.trim();
  const authorization = serverToken
    ? `Discogs token=${serverToken}`
    : queryValue(req.headers.authorization);
  const upstreamUrl = new URL(path, DISCOGS_API_URL);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key !== 'path' && value !== undefined) {
      for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
    }
  }
  upstreamUrl.search = query.toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': DISCOGS_USER_AGENT,
        ...(authorization ? { Authorization: authorization } : {}),
      },
      signal: controller.signal,
    });
    const body = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    for (const header of FORWARDED_HEADERS) {
      const value = upstreamResponse.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.status(upstreamResponse.status).send(responseBody(contentType, body));
  } catch (error) {
    const status = error instanceof DOMException && error.name === 'AbortError' ? 504 : 502;
    res
      .status(status)
      .json({ error: status === 504 ? 'Discogs request timed out' : 'Discogs request failed' });
  } finally {
    clearTimeout(timeout);
  }
}
