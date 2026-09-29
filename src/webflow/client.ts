import { toApiError, WebflowApiError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Query = Record<string, string | number | boolean | undefined>;

export interface WebflowClientOptions {
  token: string;
  baseUrl?: string;
  /** Maximum retries for rate limits, transient server errors and network failures. */
  maxRetries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
}

const DEFAULT_BASE_URL = "https://api.webflow.com/v2";
/** Methods that are safe to replay after a 5xx or network failure. */
const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(["GET", "PUT", "DELETE"]);
const MAX_BACKOFF_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Thin, typed wrapper over the Webflow Data API v2.
 *
 * - 429 responses are always retried (the request was not processed), honoring Retry-After.
 * - 5xx and network errors are retried only for idempotent methods, with jittered exponential backoff.
 */
export class WebflowClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WebflowClientOptions) {
    if (!options.token) throw new Error("WebflowClient requires an API token");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }
  put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }
  patch<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PATCH", path, { body, query });
  }
  delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }

  /** Fetches every page of an offset-paginated list endpoint. */
  async paginate<T>(path: string, key: string, query: Query = {}, pageSize = 100): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.get<Record<string, unknown>>(path, { ...query, limit: pageSize, offset });
      const batch = (page[key] as T[] | undefined) ?? [];
      out.push(...batch);
      const total = (page.pagination as { total?: number } | undefined)?.total;
      if (batch.length < pageSize || (total !== undefined && out.length >= total)) return out;
    }
  }

  async request<T>(method: HttpMethod, path: string, { query, body }: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, query);
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        if (attempt < this.maxRetries && IDEMPOTENT.has(method)) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        const reason = err instanceof Error ? err.message : String(err);
        throw new WebflowApiError(0, method, path, `network error: ${reason}`);
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const retryable = res.status === 429 || (res.status >= 500 && IDEMPOTENT.has(method));
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, MAX_BACKOFF_MS * 2)
            : this.backoff(attempt),
        );
        continue;
      }
      throw await toApiError(res, method, path);
    }
  }

  private buildUrl(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private backoff(attempt: number): number {
    const base = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
    return base / 2 + Math.random() * (base / 2);
  }
}
