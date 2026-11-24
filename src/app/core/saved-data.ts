/**
 * Everything the site shows is saved on GitHub by the scheduled refresh workflow
 * (.github/workflows/missing-albums-refresh.yml), so browsers read it instead of Discogs.
 */
const REPOSITORY = 'https://raw.githubusercontent.com/cadmanc/vinyl-archive';
export const SAVED_DATA_URL = `${REPOSITORY}/missing-albums-data`;
/** The owner's wantlist and hidden albums, changed through the site's owner-only functions. */
export const OWNER_DATA_URL = `${REPOSITORY}/owner-data`;

// GitHub serves these files with a few minutes of caching, so the device that made a change
// keeps its own copy until GitHub has caught up.
const OWNER_CHANGE_KEEP_MS = 10 * 60 * 1000;

export async function fetchSaved<T>(url: string): Promise<T | null> {
  const response = await fetch(url, { cache: 'no-cache' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Saved data request failed with ${response.status}`);
  return (await response.json()) as T;
}

export function rememberOwnerChange<T>(name: string, value: T): void {
  try {
    localStorage.setItem(`owner-change:${name}`, JSON.stringify({ savedAt: Date.now(), value }));
  } catch {
    // Without storage the change still shows once GitHub's copy updates.
  }
}

export function recentOwnerChange<T>(name: string): T | null {
  try {
    const saved = JSON.parse(localStorage.getItem(`owner-change:${name}`) ?? 'null') as {
      savedAt: number;
      value: T;
    } | null;
    return saved && Date.now() - saved.savedAt < OWNER_CHANGE_KEEP_MS ? saved.value : null;
  } catch {
    return null;
  }
}
