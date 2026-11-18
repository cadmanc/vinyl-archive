import { Injectable } from '@angular/core';

export interface MissingAlbum {
  masterId: number;
  title: string;
  year?: number;
}

export interface ArtistAlbumsResult {
  albums: MissingAlbum[];
  complete: boolean;
  checked: number;
  total: number;
}

export interface VinylPressing {
  releaseId: number;
  year?: number;
  country?: string;
  label?: string;
  catno?: string;
  discs?: number;
  descriptions: string[];
  details?: string;
}

// Shown in the line's own position (disc count) or implied by every vinyl album.
const HIDDEN_DESCRIPTIONS = new Set(['LP', 'Album', 'Compilation', 'Stereo', '12"', '33 ⅓ RPM']);

export function pressingSummary(pressing: VinylPressing): string {
  const origin = [pressing.year ?? 'Year unknown', pressing.country].filter(Boolean).join(' ');
  const tags = pressing.descriptions.filter((description) => !HIDDEN_DESCRIPTIONS.has(description));
  const discs = pressing.discs && pressing.discs > 1 ? `${pressing.discs}LP` : 'LP';
  return [origin, ...tags, pressing.details, discs].filter(Boolean).join(' · ');
}

export function pressingLabel(pressing: VinylPressing): string {
  return [pressing.label, pressing.catno].filter(Boolean).join(' · ');
}

@Injectable({ providedIn: 'root' })
export class MissingAlbumsService {
  async loadArtistAlbums(releaseId: number): Promise<ArtistAlbumsResult> {
    return this.request<ArtistAlbumsResult>(`/api/missing-albums?releaseId=${releaseId}`);
  }

  async loadPressings(
    masterId: number,
  ): Promise<{ pressings: VinylPressing[]; complete: boolean }> {
    return this.request(`/api/missing-albums?masterId=${masterId}`);
  }

  private async request<T>(url: string): Promise<T> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Missing albums request failed with ${response.status}`);
    return (await response.json()) as T;
  }
}
