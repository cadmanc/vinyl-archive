type VercelRequest = {
  method?: string;
};

type VercelResponse = {
  status: (statusCode: number) => VercelResponse;
  setHeader: (name: string, value: string) => VercelResponse;
  json: (body: unknown) => VercelResponse;
};

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET').status(405).json({ error: 'Method not allowed' });
    return;
  }

  const username = process.env.DISCOGS_USERNAME?.trim();
  const tokenConfigured = Boolean(process.env.DISCOGS_TOKEN?.trim());
  res
    .status(200)
    .json({ configured: tokenConfigured && Boolean(username), username: username ?? '' });
}
