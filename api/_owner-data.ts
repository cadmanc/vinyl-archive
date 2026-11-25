/**
 * Owner-controlled files (hidden albums, wantlist) on the owner-data branch, which the site
 * reads straight from GitHub. Written through the GitHub contents API so the site's owner
 * changes and the scheduled job never overwrite each other. Files starting with "_" aren't
 * deployed as their own Vercel function.
 */
export const OWNER_DATA_BRANCH = 'owner-data';
const DEFAULT_REPOSITORY = 'cadmanc/vinyl-archive';
const ATTEMPTS = 4;

export interface WantlistFile {
  releaseIds: number[];
  /** Wanted pressings grouped by Discogs master, for the green dots on missing albums. */
  byMaster?: Record<string, number[]>;
}

/** Adds or removes a pressing, and keeps the master grouping in step when `masterId` is known. */
export function applyWantlistChange(
  current: WantlistFile | null | undefined,
  releaseId: number,
  wanted: boolean,
  masterId?: number,
): WantlistFile {
  const releaseIds = new Set(current?.releaseIds ?? []);
  const byMaster: Record<string, number[]> = { ...(current?.byMaster ?? {}) };
  if (wanted) releaseIds.add(releaseId);
  else releaseIds.delete(releaseId);

  if (masterId && masterId > 0) {
    const key = String(masterId);
    const ids = new Set(byMaster[key] ?? []);
    if (wanted) ids.add(releaseId);
    else ids.delete(releaseId);
    if (ids.size) byMaster[key] = sortedIds(ids);
    else delete byMaster[key];
  } else if (!wanted) {
    for (const key of Object.keys(byMaster)) {
      const next = byMaster[key].filter((id) => id !== releaseId);
      if (next.length) byMaster[key] = next;
      else delete byMaster[key];
    }
  }

  return {
    releaseIds: sortedIds(releaseIds),
    ...(Object.keys(byMaster).length ? { byMaster } : {}),
  };
}

export interface HiddenAlbumsFile {
  masterIds: number[];
  /** EPs/compilations the owner unhid; the daily job must not hide these again. */
  revealedMasterIds?: number[];
}

export function applyHiddenChange(
  current: HiddenAlbumsFile | null | undefined,
  masterId: number,
  hide: boolean,
): HiddenAlbumsFile {
  const ids = new Set(current?.masterIds ?? []);
  const revealed = new Set(current?.revealedMasterIds ?? []);
  if (hide) {
    ids.add(masterId);
    revealed.delete(masterId);
  } else {
    ids.delete(masterId);
    revealed.add(masterId);
  }
  return {
    masterIds: sortedIds(ids),
    ...(revealed.size ? { revealedMasterIds: sortedIds(revealed) } : {}),
  };
}

/** Hides newly found EPs and compilations without undoing anything the owner unhid. */
export function autoHideSecondaryAlbums(
  current: HiddenAlbumsFile | null | undefined,
  secondaryIds: Iterable<number>,
): HiddenAlbumsFile {
  const ids = new Set(current?.masterIds ?? []);
  const revealed = new Set(current?.revealedMasterIds ?? []);
  for (const id of secondaryIds) {
    if (!revealed.has(id)) ids.add(id);
  }
  return {
    masterIds: sortedIds(ids),
    ...(revealed.size ? { revealedMasterIds: sortedIds(revealed) } : {}),
  };
}

function contentsUrl(file: string): string {
  const repository = process.env['GITHUB_DATA_REPOSITORY']?.trim() || DEFAULT_REPOSITORY;
  return `https://api.github.com/repos/${repository}/contents/${encodeURIComponent(file)}`;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'VinylArchive/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function readFile<T>(
  file: string,
  token: string,
): Promise<{ value: T | null; sha?: string }> {
  const response = await fetch(`${contentsUrl(file)}?ref=${OWNER_DATA_BRANCH}`, {
    headers: headers(token),
  });
  if (response.status === 404) return { value: null };
  if (!response.ok) throw new Error(`GitHub read of ${file} failed with ${response.status}`);
  const body = (await response.json()) as { content: string; sha: string };
  return {
    value: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) as T,
    sha: body.sha,
  };
}

export async function readOwnerFile<T>(file: string, token: string): Promise<T | null> {
  return (await readFile<T>(file, token)).value;
}

/**
 * Applies `update` to the latest copy of the file and saves it, retrying when someone else
 * saved in between. Nothing is written when the update leaves the file unchanged.
 */
export async function updateOwnerFile<T>(
  file: string,
  token: string,
  update: (current: T | null) => T,
  message: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const { value, sha } = await readFile<T>(file, token);
    const next = update(value);
    if (value !== null && JSON.stringify(next) === JSON.stringify(value)) return next;
    const response = await fetch(contentsUrl(file), {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        branch: OWNER_DATA_BRANCH,
        content: Buffer.from(`${JSON.stringify(next, null, 1)}\n`).toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    if (response.ok) return next;
    const conflict = response.status === 409 || response.status === 422;
    if (!conflict || attempt >= ATTEMPTS) {
      throw new Error(`GitHub write of ${file} failed with ${response.status}`);
    }
  }
}

export function sortedIds(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}
