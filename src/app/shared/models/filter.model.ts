export interface RecommendationFilters {
  excludeBoxSets: boolean;
  genres: string[];
  decades: string[];
  originalDecades: string[];
  notPlayedIn6Months: boolean;
  vinylSizes: string[];
  discCounts: number[];
}

export const DEFAULT_FILTERS: RecommendationFilters = {
  excludeBoxSets: true,
  genres: [],
  decades: [],
  originalDecades: [],
  notPlayedIn6Months: false,
  vinylSizes: [],
  discCounts: [],
};

/** Genre filters Discogs only tracks as styles, matched against each release's styles. */
export const STYLE_GENRES: Record<string, RegExp> = {
  Punk: /punk/i,
  'Heavy Metal': /metal|thrash/i,
  Rap: /\brap\b|trap|gangsta|hip-hop|boom bap|conscious|g-funk|horrorcore/i,
};

export function matchesGenre(genre: string, genres: string[], styles: string[]): boolean {
  const stylePattern = STYLE_GENRES[genre];
  return stylePattern ? styles.some((style) => stylePattern.test(style)) : genres.includes(genre);
}
