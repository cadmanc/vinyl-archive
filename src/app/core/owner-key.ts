const OWNER_KEY_STORAGE = 'wantlist-owner-key';
const OWNER_LINK_PREFIX = '#owner=';

/**
 * The key that unlocks owner-only features on this device. Opening the owner link
 * (`/#owner=<key>`) saves it and removes it from the address bar.
 */
export function readOwnerKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    if (window.location.hash.startsWith(OWNER_LINK_PREFIX)) {
      const key = decodeURIComponent(window.location.hash.slice(OWNER_LINK_PREFIX.length));
      window.localStorage.setItem(OWNER_KEY_STORAGE, key);
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname + window.location.search,
      );
    }
    return window.localStorage.getItem(OWNER_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function forgetOwnerKey(): void {
  try {
    window.localStorage.removeItem(OWNER_KEY_STORAGE);
  } catch {
    // Storage can be unavailable in private browsing; the key is already dropped for this visit.
  }
}
