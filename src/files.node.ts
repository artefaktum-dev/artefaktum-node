/**
 * The Node-only half of the file layer: path sources and path destinations (design spec
 * §7). This is the ONLY module that imports `node:*`, and it is reached only through
 * `loadNode()`'s dynamic import, so the rest of the package loads on runtimes without
 * Node's built-ins.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { IntegrityError, StorageError } from "./errors.js";
import { type Prepared, hostOf, safeBasename } from "./files.js";
import { contentTypeFor } from "./mime.js";
import type { FetchLike } from "./transport.js";

export function toPath(source: string | URL): string {
  return source instanceof URL ? fileURLToPath(source) : source;
}

/** Hash and size a file by streaming it; it is never held in memory whole. */
export async function preparePath(
  source: string | URL,
  opts: { filename?: string; content_type?: string },
): Promise<Prepared> {
  const path = toPath(source);
  const filename = opts.filename ?? basename(path);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return {
    sha256: hash.digest("hex"),
    size,
    filename,
    content_type: opts.content_type ?? contentTypeFor(filename),
    // A stream body alone goes out `Transfer-Encoding: chunked`, which S3 and R2 reject on
    // a presigned PUT with 501 (MinIO tolerates it, so a dev stack would not show this).
    // An explicit Content-Length makes undici frame the stream by length instead, with flat
    // memory; `fs.openAsBlob` would frame correctly too but buffers the whole file.
    // tests/files.node.test.ts pins this on a real socket.
    open: async () => ({
      body: Readable.toWeb(createReadStream(path)) as unknown as BodyInit,
      headers: { "Content-Length": String(size) },
      duplex: "half",
    }),
  };
}

/**
 * The file to write. `dest` is a directory when it exists as one, or when it is spelled
 * with a trailing separator (then it is created); the name inside it is the server's
 * filename reduced to a basename. Otherwise `dest` is the file itself.
 */
export async function resolveDest(dest: string, filename: string): Promise<string> {
  const spelledAsDirectory = dest.endsWith("/") || dest.endsWith(sep);
  if (spelledAsDirectory) await mkdir(dest, { recursive: true });
  const isDirectory =
    spelledAsDirectory ||
    // Any `stat` failure -- missing path, EACCES, whatever -- is deliberately read as "not a
    // directory", the way Python's `Path.is_dir()` does. The real errno isn't lost: it
    // surfaces a moment later from the write to `dest` itself.
    (await stat(dest).then(
      (s) => s.isDirectory(),
      () => false,
    ));
  return isDirectory ? join(dest, safeBasename(filename)) : dest;
}

/**
 * A temp file no other download can be writing. Two pulls of one artifact into one
 * directory would otherwise stream into the same `<final>.part`: each verifies only the
 * chunks it wrote itself, so the mixture passes both digest checks, and whichever renames
 * first leaves the other renaming a path that is gone.
 */
function partPath(final: string): string {
  return `${final}.${randomBytes(4).toString("hex")}.part`;
}

/**
 * Stream a signed GET to a private temp file while hashing, verify, then rename into place. Any
 * failure removes the part file, and an existing file at the destination is only ever
 * replaced by verified bytes.
 */
export async function downloadToPath(
  fetchImpl: FetchLike,
  url: string,
  dest: string,
  opts: { filename: string; expected_sha256: string | null; signal?: AbortSignal },
): Promise<string> {
  const final = await resolveDest(dest, opts.filename);
  const part = partPath(final);
  const hash = createHash("sha256");
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { method: "GET", signal: opts.signal });
    } catch (cause) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      throw new StorageError(undefined, hostOf(url), cause);
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new StorageError(response.status, hostOf(url));
    }
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as NodeWebStream), tap, createWriteStream(part));
    } catch (cause) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      // undici reports a connection dropped mid-body as `TypeError: terminated`; disk
      // errors (ENOSPC, EACCES) are not TypeErrors and pass through as Node's own.
      if (cause instanceof TypeError) throw new StorageError(undefined, hostOf(url), cause);
      throw cause;
    }
    const actual = hash.digest("hex");
    if (opts.expected_sha256 !== null && actual !== opts.expected_sha256) {
      throw new IntegrityError(opts.expected_sha256, actual);
    }
    await rename(part, final);
    return final;
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
