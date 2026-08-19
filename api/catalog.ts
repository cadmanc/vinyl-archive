import { readCatalog } from './catalog.repository.js';

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
  } catch {
    res.status(500).json({ error: 'Catalog could not be read' });
  }
}
