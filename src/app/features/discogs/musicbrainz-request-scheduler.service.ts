import { Injectable } from '@angular/core';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams,
  HttpResponse,
} from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

interface MusicBrainzRequestOptions {
  headers?: HttpHeaders;
  params?: HttpParams | Record<string, string | string[]>;
}

interface QueueItem {
  key: string;
  url: string;
  options: MusicBrainzRequestOptions;
  resolve: (response: HttpResponse<unknown>) => void;
  reject: (error: unknown) => void;
}

@Injectable({ providedIn: 'root' })
export class MusicBrainzRequestScheduler {
  private readonly queue: QueueItem[] = [];
  private readonly completed = new Map<string, HttpResponse<unknown>>();
  private readonly pending = new Map<string, Promise<HttpResponse<unknown>>>();
  private processing = false;
  private nextRequestAt = 0;

  constructor(private http: HttpClient) {}

  request<T>(
    key: string,
    url: string,
    options: MusicBrainzRequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const cached = this.completed.get(key);
    if (cached) return Promise.resolve(cached as HttpResponse<T>);

    const pending = this.pending.get(key);
    if (pending) return pending as Promise<HttpResponse<T>>;

    const request = new Promise<HttpResponse<T>>((resolve, reject) => {
      this.queue.push({
        key,
        url,
        options,
        resolve: (response) => resolve(response as HttpResponse<T>),
        reject,
      });
      void this.processQueue();
    });
    this.pending.set(key, request as Promise<HttpResponse<unknown>>);
    void request.then(
      (response) => {
        this.pending.delete(key);
        this.completed.set(key, response as HttpResponse<unknown>);
      },
      () => this.pending.delete(key),
    );
    return request;
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        try {
          item.resolve(await this.executeWithRetry(item.url, item.options));
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) void this.processQueue();
    }
  }

  private async executeWithRetry<T>(
    url: string,
    options: MusicBrainzRequestOptions,
  ): Promise<HttpResponse<T>> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitUntilNextRequest();
      try {
        const response = await firstValueFrom(
          this.http.get<T>(url, { ...options, observe: 'response' } as { observe: 'response' }),
        );
        const normalized =
          response instanceof HttpResponse
            ? response
            : new HttpResponse<T>({ body: response as T, status: 200, headers: new HttpHeaders() });
        this.nextRequestAt = Date.now() + MUSICBRAINZ_REQUEST_INTERVAL_MS;
        return normalized;
      } catch (error) {
        if (!this.isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;
        const retryDelay = this.retryDelay(error, attempt);
        console.warn(`Retry ${attempt}/${MAX_ATTEMPTS} for MusicBrainz in ${retryDelay}ms`);
        this.nextRequestAt = Date.now() + retryDelay;
      }
    }
    throw new Error('MusicBrainz request retry loop terminated unexpectedly');
  }

  private isRetryable(error: unknown): boolean {
    return !(error instanceof HttpErrorResponse) || RETRYABLE_STATUSES.has(error.status);
  }

  private retryDelay(error: unknown, attempt: number): number {
    const retryAfter = error instanceof HttpErrorResponse ? error.headers.get('Retry-After') : null;
    const retrySeconds = retryAfter == null ? NaN : Number(retryAfter);
    if (Number.isFinite(retrySeconds))
      return Math.max(MUSICBRAINZ_REQUEST_INTERVAL_MS, retrySeconds * 1000);
    const backoff = MUSICBRAINZ_REQUEST_INTERVAL_MS * Math.pow(2, attempt - 1);
    return backoff + Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 4)));
  }

  private async waitUntilNextRequest(): Promise<void> {
    const delay = this.nextRequestAt - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
