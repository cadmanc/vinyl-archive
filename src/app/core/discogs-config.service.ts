import { Injectable } from '@angular/core';

interface DiscogsServerConfig {
  configured: boolean;
  username?: string;
}

@Injectable({
  providedIn: 'root',
})
export class DiscogsConfigService {
  async load(): Promise<DiscogsServerConfig> {
    try {
      const response = await fetch('/api/discogs-config');
      if (!response.ok) return { configured: false };

      const config = (await response.json()) as DiscogsServerConfig;
      return config.configured && config.username?.trim()
        ? { configured: true, username: config.username.trim() }
        : { configured: false };
    } catch {
      return { configured: false };
    }
  }
}
