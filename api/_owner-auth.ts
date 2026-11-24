import { createHash, timingSafeEqual } from 'node:crypto';

type RequestWithHeaders = {
  headers: Record<string, string | string[] | undefined>;
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** The site is public, so only requests carrying the owner's key may change owner data. */
export function hasOwnerKey(req: RequestWithHeaders, ownerKey: string): boolean {
  const value = req.headers['x-owner-key'];
  const provided = Array.isArray(value) ? value[0] : value;
  if (!provided) return false;
  return timingSafeEqual(digest(provided), digest(ownerKey));
}
