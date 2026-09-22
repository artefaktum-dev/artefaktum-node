import { describe, expect, it } from "vitest";
import { ArtefaktumError, IntegrityError, ProcessingFailedError, ProcessingTimeoutError, StorageError } from "../src/errors.js";
import {
  fetchBytes, hostOf, isPathSource, prepareBytes, pullPlan, putToStorage, safeBasename, sha256Hex, signedVersion, waitReady,
} from "../src/files.js";
import { DOWNLOAD, HELLO_SHA256, UPLOAD, VERSION_VIEW, artifact } from "./fixtures.js";
import { fakeFetch } from "./helpers.js";

const HELLO = new TextEncoder().encode("hello");

describe("sha256Hex", () => {
  it("hashes bytes", async () => {
    expect(await sha256Hex(HELLO)).toBe(HELLO_SHA256);
  });
});

describe("isPathSource", () => {
  it("treats strings and URLs as paths, everything else as bytes", () => {
    expect(isPathSource("a.txt")).toBe(true);
    expect(isPathSource(new URL("file:///tmp/a.txt"))).toBe(true);
    expect(isPathSource(HELLO)).toBe(false);
    expect(isPathSource(new Blob(["x"]))).toBe(false);
    expect(isPathSource(new ArrayBuffer(1))).toBe(false);
  });
});

describe("prepareBytes", () => {
  it("hashes and sizes a Uint8Array, guessing the type from the name", async () => {
    const p = await prepareBytes(HELLO, { filename: "hello.txt" });
    expect(p).toMatchObject({ sha256: HELLO_SHA256, size: 5, filename: "hello.txt", content_type: "text/plain" });
    const put = await p.open();
    expect(put.headers).toEqual({});
    expect(put.duplex).toBeUndefined();
    expect(new Uint8Array(await new Response(put.body).arrayBuffer())).toEqual(HELLO);
  });

  it("accepts an ArrayBuffer", async () => {
    const buffer = HELLO.buffer.slice(HELLO.byteOffset, HELLO.byteOffset + HELLO.byteLength) as ArrayBuffer;
    expect((await prepareBytes(buffer, { filename: "h.bin" })).sha256).toBe(HELLO_SHA256);
  });

  it("uses a Blob's type and a File's name", async () => {
    const blob = await prepareBytes(new Blob([HELLO], { type: "text/x-greeting" }), { filename: "h.txt" });
    expect(blob.content_type).toBe("text/x-greeting");
    const file = await prepareBytes(new File([HELLO], "named.csv"), {});
    expect(file.filename).toBe("named.csv");
    expect(file.content_type).toBe("text/csv");
    expect(file.sha256).toBe(HELLO_SHA256);
  });

  it("lets the options win", async () => {
    const p = await prepareBytes(new File([HELLO], "named.csv", { type: "text/csv" }), { filename: "other.bin", content_type: "application/x-custom" });
    expect([p.filename, p.content_type]).toEqual(["other.bin", "application/x-custom"]);
  });

  it("needs a filename for nameless bytes", async () => {
    await expect(prepareBytes(HELLO, {})).rejects.toThrow(TypeError);
    await expect(prepareBytes(new Blob([HELLO]), {})).rejects.toThrow(/filename is required/);
  });
});

describe("hostOf / safeBasename", () => {
  it("keeps only the host of a signed URL", () => {
    expect(hostOf(UPLOAD.url)).toBe("storage.test");
    expect(hostOf("not a url")).toBe("unknown host");
  });

  it.each([
    ["hello.txt", "hello.txt"],
    ["../../.ssh/authorized_keys", "authorized_keys"],
    ["/etc/cron.d/evil", "evil"],
    ["a/b.txt", "b.txt"],
    ["..\\..\\windows\\system.ini", "system.ini"],
  ])("reduces %j to %j", (input, expected) => {
    expect(safeBasename(input)).toBe(expected);
  });

  it.each([[""], ["."], [".."], ["a/"], ["a/.."]])("refuses %j", (input) => {
    expect(() => safeBasename(input)).toThrow(/not usable as a file name/);
  });
});

describe("putToStorage", () => {
  it("PUTs with exactly the signed headers and no Authorization", async () => {
    const { fetch, requests } = fakeFetch([new Response(null, { status: 200 })]);
    await putToStorage(fetch, UPLOAD, await prepareBytes(HELLO, { filename: "hello.txt" }));
    const [req] = requests;
    expect(req!.method).toBe("PUT");
    expect(req!.url.href).toBe(UPLOAD.url);
    expect(req!.headers.get("content-type")).toBe("text/plain");
    expect(req!.headers.get("authorization")).toBeNull();
    expect([...req!.headers.keys()]).toEqual(["content-type"]);
  });

  it("lets the body's own headers replace a signed header of the same name, whatever its case", async () => {
    const { fetch, requests } = fakeFetch([new Response(null, { status: 200 })]);
    const prepared = await prepareBytes(HELLO, { filename: "hello.txt" });
    const withLength = { ...prepared, open: async () => ({ body: HELLO as BodyInit, headers: { "Content-Length": "5" } }) };
    await putToStorage(fetch, { ...UPLOAD, headers: { "content-length": "999", "Content-Type": "text/plain" } }, withLength);
    expect(requests[0]!.headers.get("content-length")).toBe("5");
  });

  it("raises StorageError with the host, never the signed URL", async () => {
    const { fetch } = fakeFetch([new Response("denied", { status: 403 })]);
    const err = (await putToStorage(fetch, UPLOAD, await prepareBytes(HELLO, { filename: "h.txt" })).catch((e: unknown) => e)) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBe(403);
    expect(err.host).toBe("storage.test");
    expect(String(err)).not.toContain("SECRETSIG");
  });

  it("wraps a network failure without leaking the URL", async () => {
    const { fetch } = fakeFetch([new TypeError("fetch failed")]);
    const err = (await putToStorage(fetch, UPLOAD, await prepareBytes(HELLO, { filename: "h.txt" })).catch((e: unknown) => e)) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(err.status).toBeUndefined();
    expect(String(err)).not.toContain("SECRETSIG");
  });

  it("rethrows the caller's abort as it is", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const { fetch } = fakeFetch([new DOMException("aborted", "AbortError")]);
    await expect(putToStorage(fetch, UPLOAD, await prepareBytes(HELLO, { filename: "h.txt" }), controller.signal)).rejects.toThrow("stop");
  });
});

describe("waitReady", () => {
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
  }

  it("polls until ready", async () => {
    const c = clock();
    const states = [artifact({ status: "processing" }), artifact({ status: "processing" }), artifact({ status: "ready" })];
    const out = await waitReady(async () => states.shift()!, { timeout_ms: 30_000, ...c });
    expect(out.status).toBe("ready");
    expect(c.slept).toEqual([500, 500]);
  });

  it("raises ProcessingFailedError with the artifact", async () => {
    const failed = artifact({ status: "failed" });
    const err = (await waitReady(async () => failed, { timeout_ms: 1000, ...clock() }).catch((e: unknown) => e)) as ProcessingFailedError;
    expect(err).toBeInstanceOf(ProcessingFailedError);
    expect(err.artifact).toBe(failed);
  });

  it("raises ProcessingTimeoutError carrying the artifact as it stands", async () => {
    const c = clock();
    const pending = artifact({ status: "processing" });
    const err = (await waitReady(async () => pending, { timeout_ms: 1200, interval_ms: 500, ...c }).catch((e: unknown) => e)) as ProcessingTimeoutError;
    expect(err).toBeInstanceOf(ProcessingTimeoutError);
    expect(err.artifact).toBe(pending);
    expect(c.slept).toEqual([500, 500, 500]);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const c = clock();
    let calls = 0;
    const get = async () => { if (++calls === 2) controller.abort(new Error("cancelled")); return artifact({ status: "processing" }); };
    await expect(waitReady(get, { timeout_ms: 60_000, signal: controller.signal, ...c })).rejects.toThrow("cancelled");
    expect(calls).toBe(2);
  });

  it("cancels promptly instead of waiting out a sleep that never resolves", async () => {
    const controller = new AbortController();
    const neverSleep = () => new Promise<void>(() => {});
    setTimeout(() => controller.abort(new Error("cancelled")), 10);
    const started = Date.now();
    await expect(
      waitReady(async () => artifact({ status: "processing" }), {
        timeout_ms: 60_000,
        signal: controller.signal,
        sleep: neverSleep,
      }),
    ).rejects.toThrow("cancelled");
    // Generous margin: this proves the abort was not left waiting on `sleep`, not that it
    // was instantaneous.
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("signedVersion / pullPlan", () => {
  it("picks the version the signed URL names", () => {
    const v2 = { ...VERSION_VIEW, id: "v2", version_number: 2 };
    expect(signedVersion([v2, VERSION_VIEW], DOWNLOAD)).toBe(VERSION_VIEW);
    expect(signedVersion([v2], DOWNLOAD)).toBeUndefined();
  });

  it("plans the digest to check, or none when verify is off", () => {
    expect(pullPlan(VERSION_VIEW, DOWNLOAD, true)).toEqual({ version: VERSION_VIEW, expected_sha256: HELLO_SHA256 });
    expect(pullPlan(VERSION_VIEW, DOWNLOAD, false).expected_sha256).toBeNull();
    expect(pullPlan({ ...VERSION_VIEW, sha256: null }, DOWNLOAD, true).expected_sha256).toBeNull();
  });

  it("refuses to pair bytes with another version's name", () => {
    const err = (() => { try { pullPlan(undefined, DOWNLOAD, true); } catch (e) { return e; } })() as ArtefaktumError;
    expect(err).toBeInstanceOf(ArtefaktumError);
    expect(err.code).toBe("version_mismatch");
  });
});

describe("fetchBytes", () => {
  it("returns verified bytes", async () => {
    const { fetch, requests } = fakeFetch([new Response(HELLO)]);
    expect(await fetchBytes(fetch, DOWNLOAD.url, HELLO_SHA256)).toEqual(HELLO);
    expect(requests[0]!.headers.get("authorization")).toBeNull();
  });

  it("raises IntegrityError on a digest mismatch", async () => {
    const { fetch } = fakeFetch([new Response("tampered")]);
    await expect(fetchBytes(fetch, DOWNLOAD.url, HELLO_SHA256)).rejects.toBeInstanceOf(IntegrityError);
  });

  it("skips the check when there is no expected digest", async () => {
    const { fetch } = fakeFetch([new Response("anything")]);
    expect(new TextDecoder().decode(await fetchBytes(fetch, DOWNLOAD.url, null))).toBe("anything");
  });

  it("raises StorageError without the signed URL", async () => {
    const { fetch } = fakeFetch([new Response("gone", { status: 404 })]);
    const err = (await fetchBytes(fetch, DOWNLOAD.url, null).catch((e: unknown) => e)) as StorageError;
    expect(err).toBeInstanceOf(StorageError);
    expect(String(err)).not.toContain("SECRETGET");
  });
});
