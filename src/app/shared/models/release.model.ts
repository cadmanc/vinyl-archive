export interface ReleaseTrack {
  position: string;
  title: string;
  duration?: string;
  type?: string;
}

export type ReleaseEnrichment = Pick<
  Release['basicInfo'],
  | 'masterId'
  | 'originalYear'
  | 'year'
  | 'label'
  | 'catalogNumber'
  | 'format'
  | 'tracklist'
  | 'detailsFetched'
  | 'trackCount'
  | 'totalRuntimeSeconds'
>;

export interface Release {
  id: number; // Discogs release ID (primary key)
  instanceId: number; // Discogs collection instance ID
  basicInfo: {
    title: string;
    artists: string[];
    year?: number;
    masterId?: number; // Discogs master release ID
    originalYear?: number; // Original release year from master
    formats: string[];
    discCount?: number; // sum of formats[].qty; undefined until re-synced from Discogs
    trackCount?: number;
    totalRuntimeSeconds?: number;
    label?: string;
    catalogNumber?: string;
    format?: string;
    tracklist?: ReleaseTrack[];
    detailsFetched?: boolean;
    thumb?: string;
    coverImage?: string;
    labels?: string[];
    genres?: string[];
    styles?: string[];
  };

  // Tracking data
  playCount: number;
  lastPlayedDate?: Date;
  dateAdded: Date;

  // Discogs metadata
  dateAddedToCollection?: Date;
  notes?: string;
  rating?: number;
  userRating?: 1 | 2 | 3; // Personal rating (1 = low, 3 = high)
}
