import type { Release } from '../src/app/shared/models/release.model.js';

export type CatalogRelease = Pick<Release, 'id' | 'instanceId' | 'basicInfo'>;

export type DiscogsCollectionItem = {
  instance_id: number;
  date_added: string;
  basic_information: {
    id: number;
    title: string;
    artists: Array<{ id?: number; name: string }>;
    year?: number;
    master_id?: number;
    formats: Array<{ name: string; qty: string; descriptions?: string[] }>;
    thumb?: string;
    cover_image?: string;
    labels: Array<{ name: string; catno?: string }>;
    genres?: string[];
    styles?: string[];
  };
};

export type DiscogsCollectionResponse = {
  pagination: { pages: number };
  releases: DiscogsCollectionItem[];
};

export function formatRelease(item: DiscogsCollectionItem): CatalogRelease {
  const info = item.basic_information;
  return {
    id: info.id,
    instanceId: item.instance_id,
    basicInfo: {
      title: info.title,
      artists: info.artists.map((artist) => artist.name),
      year: info.year || undefined,
      masterId: info.master_id || undefined,
      formats: info.formats.map(
        (format) =>
          `${format.name}${format.descriptions?.length ? ` (${format.descriptions.join(', ')})` : ''}`,
      ),
      thumb: info.thumb,
      coverImage: info.cover_image,
      labels: info.labels.map((label) => label.name),
      label: info.labels[0]?.name,
      catalogNumber: info.labels[0]?.catno,
      genres: info.genres,
      styles: info.styles,
    },
  };
}
