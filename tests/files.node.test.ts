import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IntegrityError, StorageError } from "../src/errors.js";
import { loadNode, prepare, putToStorage } from "../src/files.js";
import { downloadToPath, preparePath, resolveDest } from "../src/files.node.js";

/** 3 MiB of patterned bytes: larger than any single stream chunk. */
const BIG = Buffer.from(Uint8Array.from({ length: 3 * 1024 * 1024 }, (_, i) => i % 251));
const BIG_SHA = createHash("sha256").update(BIG).digest("hex");

interface Seen { method: string; headers: IncomingHttpHeaders; body: Buffer }

let server: Server;
let base: string;
let seen: Seen[] = [];
/** What GET answers with; tests set it. */
let served: { status: number; body: Buffer } = { status: 200, body: BIG };
let putStatus = 200;
let dir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      if (req.method === "PUT") {
        res.statusCode = putStatus;
        res.end();
      } else {
        res.statusCode = served.status;
        res.end(served.body);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen = [];
  served = { status: 200, body: BIG };
  putStatus = 200;
  dir = mkdtempSync(join(tmpdir(), "artefaktum-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function upload(path = "/bucket/object?X-Amz-Signature=SECRETSIG") {
  return { method: "PUT", url: `${base}${path}`, headers: { "Content-Type": "application/octet-stream" }, expires_at: "2026-09-21T10:15:00Z" };
}

describe("preparePath", () => {
  it("hashes and sizes a file larger than one chunk without being told its name", async () => {
    const path = join(dir, "big.parquet");
    writeFileSync(path, BIG);
    const p = await preparePath(path, {});
    expect(p).toMatchObject({ sha256: BIG_SHA, size: BIG.length, filename: "big.parquet", content_type: "application/vnd.apache.parquet" });
  });

  it("accepts a file: URL and lets the options win", async () => {
    const path = join(dir, "data.csv");
    writeFileSync(path, "a,b\n1,2\n");
    const p = await preparePath(pathToFileURL(path), { filename: "renamed.bin", content_type: "application/x-custom" });
    expect([p.filename, p.content_type, p.size]).toEqual(["renamed.bin", "application/x-custom", 8]);
  });

  it("surfaces a missing file as Node's own error", async () => {
    await expect(preparePath(join(dir, "nope.txt"), {})).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is what prepare() uses for a path source", async () => {
    const path = join(dir, "hello.txt");
    writeFileSync(path, "hello");
    expect((await prepare(path, {})).size).toBe(5);
    expect(typeof (await loadNode()).preparePath).toBe("function");
  });
});

describe("the storage PUT on the wire", () => {
  it("streams a path source with Content-Length, never chunked, never authenticated", async () => {
    const path = join(dir, "big.bin");
    writeFileSync(path, BIG);
    await putToStorage(globalThis.fetch, upload(), await preparePath(path, {}));
    expect(seen).toHaveLength(1);
    const [put] = seen;
    expect(put!.method).toBe("PUT");
    expect(put!.headers["content-length"]).toBe(String(BIG.length));
    expect(put!.headers["transfer-encoding"]).toBeUndefined();
    expect(put!.headers["authorization"]).toBeUndefined();
    expect(put!.headers["content-type"]).toBe("application/octet-stream");
    expect(createHash("sha256").update(put!.body).digest("hex")).toBe(BIG_SHA);
  });

  it("frames a bytes source with Content-Length too", async () => {
    await putToStorage(globalThis.fetch, upload(), await prepare(new Uint8Array(BIG), { filename: "big.bin" }));
    expect(seen[0]!.headers["content-length"]).toBe(String(BIG.length));
    expect(seen[0]!.headers["transfer-encoding"]).toBeUndefined();
  });

  it("can PUT the same prepared source twice (a fresh stream each time)", async () => {
    const path = join(dir, "twice.bin");
    writeFileSync(path, BIG);
    const prepared = await preparePath(path, {});
    await putToStorage(globalThis.fetch, upload(), prepared);
    await putToStorage(globalThis.fetch, upload(), prepared);
    expect(seen.map((s) => s.body.length)).toEqual([BIG.length, BIG.length]);
  });

  it("raises StorageError, without the signed URL, when storage refuses", async () => {
    putStatus = 403;
    const path = join(dir, "x.bin");
    writeFileSync(path, "x");
    const err = (await putToStorage(globalThis.fetch, upload(), await preparePath(path, {})).catch((e: unknown) => e)) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(403);
    expect(String(err)).not.toContain("SECRETSIG");
  });
});

describe("resolveDest", () => {
  it("writes to the path given when it is not a directory", async () => {
    expect(await resolveDest(join(dir, "out.bin"), "server-name.txt")).toBe(join(dir, "out.bin"));
  });

  it("uses the server's basename inside an existing directory", async () => {
    expect(await resolveDest(dir, "server-name.txt")).toBe(join(dir, "server-name.txt"));
  });

  it("creates a directory spelled with a trailing separator", async () => {
    const target = join(dir, "nested", "out") + sep;
    expect(await resolveDest(target, "f.txt")).toBe(join(dir, "nested", "out", "f.txt"));
    expect(existsSync(join(dir, "nested", "out"))).toBe(true);
  });

  it("keeps a hostile filename inside the directory", async () => {
    expect(await resolveDest(dir, "../../.ssh/authorized_keys")).toBe(join(dir, "authorized_keys"));
  });
});

describe("downloadToPath", () => {
  const url = () => `${base}/bucket/object?X-Amz-Signature=SECRETGET`;

  it("streams to a part file, verifies, then renames", async () => {
    const out = await downloadToPath(globalThis.fetch, url(), dir + sep, { filename: "big.bin", expected_sha256: BIG_SHA });
    expect(out).toBe(join(dir, "big.bin"));
    expect(readFileSync(out).equals(BIG)).toBe(true);
    expect(readdirSync(dir)).toEqual(["big.bin"]);
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
  });

  it("leaves nothing behind on a digest mismatch", async () => {
    const err = await downloadToPath(globalThis.fetch, url(), dir, { filename: "big.bin", expected_sha256: "0".repeat(64) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect((err as IntegrityError).actual).toBe(BIG_SHA);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not replace an existing file when verification fails", async () => {
    const target = join(dir, "keep.bin");
    writeFileSync(target, "precious");
    await downloadToPath(globalThis.fetch, url(), target, { filename: "ignored", expected_sha256: "0".repeat(64) }).catch(() => undefined);
    expect(readFileSync(target, "utf8")).toBe("precious");
    expect(readdirSync(dir)).toEqual(["keep.bin"]);
  });

  it("skips verification when there is no expected digest", async () => {
    served = { status: 200, body: Buffer.from("anything") };
    const out = await downloadToPath(globalThis.fetch, url(), join(dir, "a.txt"), { filename: "ignored", expected_sha256: null });
    expect(readFileSync(out, "utf8")).toBe("anything");
  });

  it("does not share its part file with a concurrent download of the same artifact", async () => {
    const first = Buffer.from("bytes of the first pull");
    const second = Buffer.from("bytes of the second pull!");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    served = { status: 200, body: second };
    let inner = "";
    // The first pull's body stops after one byte while a second pull of the same artifact
    // runs to completion into the same directory, then finishes.
    const pausing = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(first.subarray(0, 1));
            inner = await downloadToPath(globalThis.fetch, url(), dir, { filename: "out.bin", expected_sha256: sha(second) });
            controller.enqueue(first.subarray(1));
            controller.close();
          },
        }),
      )) as unknown as typeof globalThis.fetch;

    const out = await downloadToPath(pausing, "https://storage.test/object", dir, { filename: "out.bin", expected_sha256: sha(first) });
    expect(inner).toBe(out);
    // The first pull finishes last, so its verified bytes are what stays on disk: never a
    // mixture of the two, and never a crash because the other pull renamed the temp away.
    expect(readFileSync(out).equals(first)).toBe(true);
    expect(readdirSync(dir)).toEqual(["out.bin"]);
  });

  it("raises StorageError, without the signed URL, and leaves no part file", async () => {
    served = { status: 404, body: Buffer.from("gone") };
    const err = (await downloadToPath(globalThis.fetch, url(), dir, { filename: "f.bin", expected_sha256: null }).catch((e: unknown) => e)) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(404);
    expect(String(err)).not.toContain("SECRETGET");
    expect(readdirSync(dir)).toEqual([]);
  });
});
