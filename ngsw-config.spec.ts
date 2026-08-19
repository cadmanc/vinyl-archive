import { readFileSync } from 'node:fs';

describe('service worker navigation', () => {
  it('excludes API routes from Angular navigation fallback', () => {
    const config = JSON.parse(readFileSync('ngsw-config.json', 'utf8')) as {
      navigationUrls: string[];
    };

    expect(config.navigationUrls).toContain('/**');
    expect(config.navigationUrls).toContain('!/api/**');
  });
});
