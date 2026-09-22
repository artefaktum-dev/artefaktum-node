/**
 * The portable file layer: hashing, the PUT to object storage, waiting for `ready`, and
 * verified downloads into memory (design spec §7). Nothing here imports `node:*`.
 *
 * These helpers talk to the object-storage host, never the API: they are handed the BARE
 * fetch, the signed URL's own `headers` are the only headers sent, and the signed URL (a
 * bearer credential) never appears in an error.
 */
import { ArtefaktumError, IntegrityError, ProcessingFailedError, ProcessingTimeoutError, StorageError } from "./errors.js";
import { contentTypeFor } from "./mime.js";
import type { FetchLike, Sleep } from "./transport.js";
import type { Artifact, ByteSource, Download, Source, UploadInstructions, Version } from "./types.js";

export interface PutBody {
  body: BodyInit;
  /** Headers the body needs on top of the signed ones (a path source sets Content-Length). */
  headers: Record<string, string>;
  /** `"half"` when `body` is a stream; `fetch` requires it. */
  duplex?: "half";
}

export interface Prepared {
  sha256: string;
  size: number;
  filename: string;
  content_type: string;
  /** A fresh request body. Called once per PUT, so a stream is never reused. */
  open(): Promise<PutBody>;
}

export function isPathSource(source: Source): source is string | URL {
  return typeof source === "string" || source instanceof URL;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The host of a signed URL -- the only part of it that is safe to show. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

/**
 * The server's filename reduced to a basename. It is the uploader's `original_filename`,
 * which the API bounds only in length: `../../.ssh/authorized_keys` must not escape the
 * destination directory. A name with nothing usable left in it is refused, not guessed at.
 */
export function safeBasename(filename: string): string {
  const name = filename.replaceAll("\\", "/").split("/").pop() ?? "";
  if (name === "" || name === "." || name === "..") {
    throw new ArtefaktumError(`server filename is not usable as a file name: ${JSON.stringify(filename)}`, {
      code: "invalid_filename",
    });
  }
  return name;
}

export async function prepareBytes(
  source: ByteSource,
  opts: { filename?: string; content_type?: string },
): Promise<Prepared> {
  const named = typeof File !== "undefined" && source instanceof File ? source.name : undefined;
  const filename = opts.filename ?? named;
  if (!filename) throw new TypeError("filename is required when the source is bytes or a Blob");
  const blobType = source instanceof Blob && source.type ? source.type : undefined;
  // A Blob is read into memory to hash it; large files belong on the path route (Node).
  const bytes =
    source instanceof Blob
      ? new Uint8Array(await source.arrayBuffer())
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : source;
  return {
    sha256: await sha256Hex(bytes),
    size: bytes.byteLength,
    filename,
    content_type: opts.content_type ?? blobType ?? contentTypeFor(filename),
    open: async () => ({ body: bytes as BodyInit, headers: {} }),
  };
}

function rethrowIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

/**
 * `promise` raced against `signal`: an abort during the wait rejects immediately with
 * `signal.reason` instead of waiting out the rest of it. The listener is `{ once: true }`
 * and is removed when `promise` itself settles first, so nothing leaks across repeated calls
 * (one per poll in `waitReady`).
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (reason: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(reason);
      },
    );
  });
}

export async function putToStorage(
  fetchImpl: FetchLike,
  upload: UploadInstructions,
  prepared: Prepared,
  signal?: AbortSignal,
): Promise<void> {
  const put = await prepared.open();
  const own = new Set(Object.keys(put.headers).map((k) => k.toLowerCase()));
  const headers: Record<string, string> = { ...put.headers };
  for (const [key, value] of Object.entries(upload.headers)) {
    if (!own.has(key.toLowerCase())) headers[key] = value;
  }
  const init: RequestInit & { duplex?: "half" } = { method: upload.method, headers, body: put.body, signal };
  if (put.duplex) init.duplex = put.duplex;

  let response: Response;
  try {
    response = await fetchImpl(upload.url, init);
  } catch (cause) {
    rethrowIfAborted(signal);
    throw new StorageError(undefined, hostOf(upload.url), cause);
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new StorageError(response.status, hostOf(upload.url));
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitReady(
  get: () => Promise<Artifact>,
  opts: { timeout_ms: number; interval_ms?: number; signal?: AbortSignal; sleep?: Sleep; now?: () => number },
): Promise<Artifact> {
  const { timeout_ms, interval_ms = 500, signal, sleep = realSleep, now = Date.now } = opts;
  const start = now();
  for (;;) {
    const artifact = await get();
    if (artifact.status === "ready") return artifact;
    if (artifact.status === "failed") throw new ProcessingFailedError(artifact);
    rethrowIfAborted(signal);
    if (now() - start >= timeout_ms) throw new ProcessingTimeoutError(artifact, timeout_ms);
    await raceAbort(sleep(interval_ms), signal);
  }
}

export function signedVersion(versions: readonly Version[], download: Download): Version | undefined {
  return versions.find((v) => v.id === download.version_id);
}

/**
 * The version whose name and digest go with the signed bytes. The signed URL names one
 * version; a `createVersion` landing between signing it and reading the metadata would
 * otherwise pair version N's bytes with version N+1's name and digest.
 */
export function pullPlan(
  version: Version | undefined,
  download: Download,
  verify: boolean,
): { version: Version; expected_sha256: string | null } {
  if (version === undefined) {
    throw new ArtefaktumError(
      `the signed download names version ${download.version_id}, which this artifact no longer lists; retry the pull`,
      { code: "version_mismatch" },
    );
  }
  return { version, expected_sha256: verify ? version.sha256 : null };
}

export async function fetchBytes(
  fetchImpl: FetchLike,
  url: string,
  expected_sha256: string | null,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let data: Uint8Array;
  try {
    const response = await fetchImpl(url, { method: "GET", signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new StorageError(response.status, hostOf(url));
    }
    data = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    rethrowIfAborted(signal);
    throw new StorageError(undefined, hostOf(url), cause);
  }
  if (expected_sha256 !== null) {
    const actual = await sha256Hex(data);
    if (actual !== expected_sha256) throw new IntegrityError(expected_sha256, actual);
  }
  return data;
}

/**
 * The Node-only module, loaded on first use. On a runtime without `node:fs` the import
 * fails and the caller is told what to pass instead.
 */
export async function loadNode(): Promise<typeof import("./files.node.js")> {
  try {
    return await import("./files.node.js");
  } catch (cause) {
    throw new ArtefaktumError("file paths need Node.js; pass bytes or a Blob on this runtime", {
      code: "unsupported_runtime",
      cause,
    });
  }
}

/** Size, digest, name and type of any source; a path goes through the Node-only module. */
export async function prepare(
  source: Source,
  opts: { filename?: string; content_type?: string },
): Promise<Prepared> {
  return isPathSource(source) ? (await loadNode()).preparePath(source, opts) : prepareBytes(source, opts);
}
