import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import {
  MUSICBRAINZ_REQUEST_INTERVAL_MS,
  MusicBrainzRequestScheduler,
} from './musicbrainz-request-scheduler.service';

describe('MusicBrainzRequestScheduler', () => {
  let http: { get: jest.Mock };
  let scheduler: MusicBrainzRequestScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    http = { get: jest.fn() };
    scheduler = new MusicBrainzRequestScheduler(http as unknown as HttpClient);
    jest.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('serializes simultaneous fallback requests and spaces starts', async () => {
    const starts: number[] = [];
    http.get.mockImplementation(
      () =>
        new Observable((subscriber) => {
          starts.push(Date.now());
          subscriber.next({ 'release-groups': [] });
          subscriber.complete();
        }),
    );

    const first = scheduler.request('artist:one:title', '/one');
    const second = scheduler.request('artist:two:title', '/two');
    await jest.advanceTimersByTimeAsync(MUSICBRAINZ_REQUEST_INTERVAL_MS);
    await Promise.all([first, second]);

    expect(http.get).toHaveBeenCalledTimes(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(MUSICBRAINZ_REQUEST_INTERVAL_MS);
  });

  it('deduplicates the same normalized lookup', async () => {
    http.get.mockReturnValue(of({ 'release-groups': [] }));

    const first = scheduler.request('normalized:artist:title', '/lookup');
    const second = scheduler.request('normalized:artist:title', '/lookup');
    await jest.advanceTimersByTimeAsync(0);
    await Promise.all([first, second]);

    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('pauses the queue after 503 and retries with bounded exponential backoff', async () => {
    const busy = new HttpErrorResponse({ status: 503, headers: new HttpHeaders() });
    http.get
      .mockReturnValueOnce(throwError(() => busy))
      .mockReturnValue(of({ 'release-groups': [] }));

    const first = scheduler.request('first', '/first');
    const second = scheduler.request('second', '/second');
    await jest.advanceTimersByTimeAsync(0);
    expect(http.get).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(MUSICBRAINZ_REQUEST_INTERVAL_MS);
    expect(http.get).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(MUSICBRAINZ_REQUEST_INTERVAL_MS);
    await Promise.all([first, second]);

    expect(http.get).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404])('does not retry status %s', async (status) => {
    const error = new HttpErrorResponse({ status });
    http.get.mockReturnValue(throwError(() => error));

    await expect(scheduler.request(`status:${status}`, `/status-${status}`)).rejects.toBe(error);
    expect(http.get).toHaveBeenCalledTimes(1);
  });
});
