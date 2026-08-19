import { Injectable } from '@angular/core';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams,
  HttpResponse,
} from '@angular/common/http';
import { firstValueFrom, Observable } from 'rxjs';
import { DISCOGS_API_DELAY_MS } from '../../shared/constants/timing.constants';

export interface DiscogsRequestOptions {
  headers?: HttpHeaders;
  params?: HttpParams | Record<string, string | string[]>;
  label?: string;
}

interface QueueItem {
  url: string;
  options: DiscogsRequestOptions;
  resolve: (response: HttpResponse<unknown>) => void;
  reject: (error: unknown) => void;
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const FALLBACK_BACKOFF_MS = DISCOGS_API_DELAY_MS;

@Injectable({ providedIn: 'root' })
export class DiscogsRequestScheduler {
  private readonly queue: QueueItem[] = [];
  private processing = false;
  private nextRequestAt = 0;

  constructor(private http: HttpClient) {}

  request<T>(url: string, options: DiscogsRequestOptions = {}): Promise<HttpResponse<T>> {
    return new Promise<HttpResponse<T>>((resolve, reject) => {
      this.queue.push({
        url,
        options,
        resolve: (response) => resolve(response as HttpResponse<T>),
        reject,
      });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;

        try {
          const response = await this.executeWithRetry(item.url, item.options);
          item.resolve(response);
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
    options: DiscogsRequestOptions,
  ): Promise<HttpResponse<T>> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitUntilNextRequest();

      try {
        const response = await firstValueFrom(this.getResponse<T>(url, options));
        const normalizedResponse =
          response instanceof HttpResponse
            ? response
            : new HttpResponse<T>({ body: response as T, status: 200, headers: new HttpHeaders() });
        this.nextRequestAt = Date.now() + DISCOGS_API_DELAY_MS;
        return normalizedResponse;
      } catch (error) {
        if (!this.isRetryable(error) || attempt === MAX_ATTEMPTS) throw error;

        const retryDelay = this.retryDelay(error, attempt);
        console.warn(
          `Retry ${attempt}/${MAX_ATTEMPTS} for ${options.label ?? 'Discogs request'} in ${retryDelay}ms`,
        );
        this.nextRequestAt = Date.now() + retryDelay;
      }
    }

    throw new Error('Discogs request retry loop terminated unexpectedly');
  }

  private getResponse<T>(url: string, options: DiscogsRequestOptions): Observable<HttpResponse<T>> {
    const { label: _label, ...httpOptions } = options;
    return this.http.get<T>(url, {
      ...httpOptions,
      observe: 'response',
    } as { observe: 'response' }) as Observable<HttpResponse<T>>;
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse)) return true;
    return RETRYABLE_STATUSES.has(error.status);
  }

  private retryDelay(error: unknown, attempt: number): number {
    const retryAfter = this.retryAfterMs(error);
    if (retryAfter != null) return retryAfter;

    const backoff = FALLBACK_BACKOFF_MS * Math.pow(2, attempt - 1);
    return backoff + Math.floor(Math.random() * Math.max(1, Math.floor(backoff / 4)));
  }

  private retryAfterMs(error: unknown): number | undefined {
    if (!(error instanceof HttpErrorResponse)) return undefined;
    const value = error.headers.get('Retry-After');
    if (!value) return undefined;

    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
  }

  private async waitUntilNextRequest(): Promise<void> {
    const waitMs = this.nextRequestAt - Date.now();
    if (waitMs > 0) await this.delay(waitMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
