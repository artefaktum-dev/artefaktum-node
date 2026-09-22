/** Client configuration: explicit option → environment → default (design spec §6). */
import { MissingApiKeyError } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.artefaktum.dev";

export interface ClientOptions {
  /** Default: `ARTEFAKTUM_API_KEY`. */
  apiKey?: string;
  /** Default: `ARTEFAKTUM_BASE_URL`, else https://api.artefaktum.dev. */
  baseUrl?: string;
  /** A project UUID or slug. Default: `ARTEFAKTUM_PROJECT`, else `"default"`. */
  project?: string;
  /** Per-attempt timeout for API calls, in milliseconds (default 30 000). Storage transfers have none. */
  timeoutMs?: number;
  /** Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface Config {
  apiKey: string;
  baseUrl: string;
  project: string;
  timeoutMs: number;
}

export type Env = Record<string, string | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `process.env` where there is one; a runtime without `process` has no env layer. */
function processEnv(): Env {
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env ?? {};
}

/**
 * `baseUrl` is a caller mistake, not a request that can fail and retry: a scheme-less value
 * (`api.artefaktum.dev`, `localhost:8000`) would otherwise burn three attempts and 1.5 s of
 * back-off before `Transport` ever gets a chance to report anything useful. `localhost:8000`
 * parses as a URL with protocol `localhost:` -- a bare parse is not enough, the scheme must
 * be http(s) too.
 */
function assertAbsoluteHttpUrl(baseUrl: string): void {
  let protocol: string | undefined;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // protocol stays undefined; falls through to the same TypeError below.
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new TypeError(
      `baseUrl must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)} (check the baseUrl option / ARTEFAKTUM_BASE_URL)`,
    );
  }
}

export function loadConfig(options: ClientOptions = {}, env: Env = processEnv()): Config {
  const apiKey = options.apiKey || env.ARTEFAKTUM_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();
  const baseUrl = (options.baseUrl || env.ARTEFAKTUM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  assertAbsoluteHttpUrl(baseUrl);
  return {
    apiKey,
    baseUrl,
    project: options.project || env.ARTEFAKTUM_PROJECT || "default",
    timeoutMs: options.timeoutMs ?? 30_000,
  };
}
