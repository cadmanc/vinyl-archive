import { TestBed } from '@angular/core/testing';
import { DiscogsConfigService } from './discogs-config.service';

describe('DiscogsConfigService', () => {
  let service: DiscogsConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(DiscogsConfigService);
  });

  it('returns valid server configuration without handling a token', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ configured: true, username: 'archive-user' }),
      }),
    });

    await expect(service.load()).resolves.toEqual({ configured: true, username: 'archive-user' });
  });

  it('preserves manual credential behavior when the server is unavailable', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: jest.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(service.load()).resolves.toEqual({ configured: false });
  });
});
