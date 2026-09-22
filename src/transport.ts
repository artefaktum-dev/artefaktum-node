/**
 * The only caller of `fetch` for the API: auth header, per-attempt timeout, retries and
 * error mapping (design spec §8). Storage transfers use the bare `fetch` exposed here and
 * get none of that -- no Authorization header, no timeout, no retry.
 */
import type { Config } from "./config.js";
import { ArtefaktumError, ConnectionError, fromProblem } from "./errors.js";
import { VERSION } from "./version.js";

export type FetchLike = typeof globalThis.fetch;
export type QueryValue = string | number | boolean | null | undefined | readonly string[];

export interface ApiRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Safe to repeat. Default: `true` for GET, `false` otherwise. */
  idempotent?: boolean;
}

export type Sleep = (ms: number) => Promise<void>;

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
/** One delay per retry: there are at most two retries, so there is no third. */
const BACKOFF_MS = [500, 1000] as const;
/**
 * The ceiling on an honoured `Retry-After`. A server -- or a proxy in front of it -- can
 * name any delay it likes; without a cap, one header parks the caller for that long inside
 * a single call.
 */
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_RETRIES = BACKOFF_MS.length;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object") for (const item of value) params.append(key, item);
    else params.append(key, String(value));
  }
  const qs = params.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
}

async function decode(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A captive portal or a misrouted proxy can answer 200 text/html; a raw SyntaxError
    // would escape the SDK's error family.
    throw new ArtefaktumError(`${response.status} ${response.statusText}: response was not JSON`, {
      code: "http_error",
      status: response.status,
    });
  }
}

async function readProblem(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A 429 whose problem code is `quota_exceeded`: the plan's allowance is spent. */
function isSpentQuota(status: number, body: unknown): boolean {
  return (
    status === 429 &&
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === "quota_exceeded"
  );
}

function delayMs(attempt: number, response: Response): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1000, MAX_RETRY_AFTER_MS);
  return BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
}

/**
 * The host to name in a `ConnectionError`. `loadConfig` already rejects a `baseUrl` that
 * `new URL` can't parse, but `connectionError` must never throw ITSELF while building an
 * error message -- so it falls back to the raw string rather than trust that invariant here.
 */
function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export class Transport {
  /** The bare fetch, for storage transfers: no Authorization header is ever added to it. */
  readonly fetch: FetchLike;
  private readonly config: Config;
  private readonly sleep: Sleep;

  constructor(config: Config, fetchImpl?: FetchLike, sleep: Sleep = realSleep) {
    if (fetchImpl === undefined && typeof globalThis.fetch !== "function") {
      throw new ArtefaktumError("no global fetch in this runtime; pass the `fetch` option", {
        code: "unsupported_runtime",
      });
    }
    this.config = config;
    // Called through `globalThis`: a detached `fetch` throws "Illegal invocation" on some runtimes.
    this.fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = sleep;
  }

  async request<T>(req: ApiRequest): Promise<T> {
    const idempotent = req.idempotent ?? req.method === "GET";
    const url = buildUrl(this.config.baseUrl, req.path, req.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "User-Agent": `artefaktum-node/${VERSION}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.body);
    }

    for (let attempt = 0; ; attempt++) {
      const canRetry = idempotent && attempt < MAX_RETRIES;
      // One try covers `fetch` AND reading the body: a connection that drops, or a timeout
      // that fires, while the body is still arriving must follow the same rule as a `fetch`
      // that never got a response at all -- retried when idempotent, else `ConnectionError`.
      try {
        const response = await this.fetch(url, {
          method: req.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        if (response.ok) return (await decode(response)) as T;

        // `readProblem` swallows its own body-read failure (`.catch(() => "")`) and degrades
        // to `http_error`, by design: a non-2xx whose body we can't read is not a reason to
        // retry, it is reported as-is below.
        const problem = await readProblem(response);
        // A spent quota is a 429 too, but waiting does not bring it back before next month.
        if (canRetry && RETRY_STATUSES.has(response.status) && !isSpentQuota(response.status, problem)) {
          await this.sleep(delayMs(attempt, response));
          continue;
        }
        throw fromProblem(response.status, problem, response.statusText);
      } catch (cause) {
        // `fromProblem`'s result (thrown above) and `decode`'s "2xx that is not JSON"
        // `http_error` are already `ArtefaktumError`s from a response the server DID send:
        // pass them through untouched, never re-wrapped as a connection failure, never
        // retried on account of this catch.
        if (cause instanceof ArtefaktumError) throw cause;
        if (canRetry) {
          await this.sleep(BACKOFF_MS[attempt]!);
          continue;
        }
        throw this.connectionError(cause);
      }
    }
  }

  private connectionError(cause: unknown): ConnectionError {
    const host = safeHost(this.config.baseUrl);
    // `AbortSignal.timeout` rejects with a DOMException named TimeoutError; read the name
    // structurally, since not every runtime's DOMException is an `Error`.
    const timedOut = (cause as { name?: unknown } | null)?.name === "TimeoutError";
    return new ConnectionError(
      timedOut ? `${host} did not answer within ${this.config.timeoutMs} ms` : `could not reach ${host}`,
      cause,
    );
  }
}
