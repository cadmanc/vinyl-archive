import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { DiscogsRequestScheduler } from './discogs-request-scheduler.service';
import { DISCOGS_API_DELAY_MS } from '../../shared/constants/timing.constants';

describe('DiscogsRequestScheduler', () => {
  let http: { get: jest.Mock };
  let scheduler: DiscogsRequestScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    http = { get: jest.fn() };
    scheduler = new DiscogsRequestScheduler(http as unknown as HttpClient);
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('serializes collection and enrichment callers on one global queue', async () => {
    let active = 0;
    let maximumActive = 0;
    http.get.mockImplementation(
      () =>
        new Observable((subscriber) => {
          active++;
          maximumActive = Math.max(maximumActive, active);
          subscriber.next({ first: true });
          subscriber.complete();
          active--;
        }),
    );

    const requests = Promise.all([
      scheduler.request('/collection', { label: 'collection page' }),
      scheduler.request('/releases/123', { label: 'release metadata' }),
    ]);
    await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);
    await requests;

    expect(maximumActive).toBe(1);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('spaces queued requests instead of dispatching a burst', async () => {
    http.get.mockReturnValue(of({ ok: true }));
    const first = scheduler.request('/one');
    await jest.advanceTimersByTimeAsync(0);
    const second = scheduler.request('/two');
    await jest.advanceTimersByTimeAsync(0);

    expect(http.get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS - 1);
    expect(http.get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  it('pauses the complete queue and honors Retry-After for 429 responses', async () => {
    http.get
      .mockReturnValueOnce(
        throwError(
          () =>
            new HttpErrorResponse({
              status: 429,
              headers: new HttpHeaders({ 'Retry-After': '5' }),
            }),
        ),
      )
      .mockReturnValue(of({ ok: true }));
    const first = scheduler.request('/rate-limited');
    await jest.advanceTimersByTimeAsync(0);
    const second = scheduler.request('/queued');

    await jest.advanceTimersByTimeAsync(4999);
    expect(http.get).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS);
    await Promise.all([first, second]);

    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it('uses bounded fallback exponential backoff without Retry-After', async () => {
    const error = new HttpErrorResponse({ status: 503 });
    http.get.mockReturnValue(throwError(() => error));
    const request = scheduler.request('/unavailable');

    await jest.advanceTimersByTimeAsync(DISCOGS_API_DELAY_MS * 20);
    await expect(request).rejects.toBe(error);
    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404])('does not retry ordinary status %s responses', async (status) => {
    const error = new HttpErrorResponse({ status });
    http.get.mockReturnValue(throwError(() => error));

    await expect(scheduler.request(`/status-${status}`)).rejects.toBe(error);

    expect(http.get).toHaveBeenCalledTimes(1);
  });
});
