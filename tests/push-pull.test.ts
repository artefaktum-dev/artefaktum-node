import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Artefaktum } from "../src/client.js";
import { ArtefaktumError, IntegrityError, ProcessingFailedError, ProcessingTimeoutError, StorageError } from "../src/errors.js";
import type { Resolution } from "../src/types.js";
import { ARTIFACT_ID, DOWNLOAD, HELLO_SHA256, PROJECT_ID, TICKET, UPLOAD, VERSION_ID, VERSION_VIEW, artifact } from "./fixtures.js";
import { type Recorded, type Reply, fakeFetch, json } from "./helpers.js";
import { assertInOpenApi } from "./openapi.js";

const HELLO = new TextEncoder().encode("hello");
const ok = () => new Response(null, { status: 200 });
const ref = () => json(TICKET.artifact);

function client(replies: Reply[]) {
  const fake = fakeFetch(replies);
  const c = new Artefaktum({ apiKey: "afk_test_key", baseUrl: "https://api.test", project: PROJECT_ID, fetch: fake.fetch }, { sleep: async () => undefined });
  return { c, ...fake };
}

const steps = (requests: Recorded[]) => requests.map((r) => `${r.method} ${r.url.host}${r.url.pathname}`);

/** The F3 drift guard: every request to the API host is a real OpenAPI operation. */
const checkAgainstOpenApi = (requests: Recorded[]) => {
  for (const r of requests) if (r.url.host === "api.test") assertInOpenApi(r);
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "artefaktum-pp-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("push", () => {
  it("reserves, uploads, completes and waits -- in that order", async () => {
    const { c, requests } = client([json(TICKET, 201), ok(), ref(), json(artifact({ status: "processing" })), json(artifact({ status: "ready" }))]);
    const out = await c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt", tags: ["greeting"] });
    expect(out.status).toBe("ready");
    expect(steps(requests)).toEqual([
      "POST api.test/v1/artifacts/uploads",
      "PUT storage.test/bucket/object",
      `POST api.test/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`,
      `GET api.test/v1/artifacts/${ARTIFACT_ID}`,
      `GET api.test/v1/artifacts/${ARTIFACT_ID}`,
    ]);
    expect(requests[0]!.body).toEqual({
      project_id: PROJECT_ID, filename: "hello.txt", content_type: "text/plain", size_bytes: 5, title: "Hello",
      description: "", tags: ["greeting"], metadata: {}, infer_lineage: true,
    });
    expect(requests[2]!.body).toEqual({ sha256: HELLO_SHA256, size_bytes: 5 });
    checkAgainstOpenApi(requests);
  });

  it("never sends the API key to the storage host, and sends exactly the signed headers", async () => {
    const { c, requests } = client([json(TICKET, 201), ok(), ref(), json(artifact())]);
    await c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt" });
    const put = requests[1]!;
    expect(put.url.href).toBe(UPLOAD.url);
    expect(put.headers.get("authorization")).toBeNull();
    expect([...put.headers.keys()]).toEqual(["content-type"]);
  });

  it("does not leak wait options or the source's name into the request body", async () => {
    const { c, requests } = client([json(TICKET, 201), ok(), ref(), json(artifact())]);
    await c.artifacts.push(HELLO, { title: "T", filename: "f.bin", content_type: "application/x-custom", wait: true, timeout_ms: 5, project: PROJECT_ID });
    expect(Object.keys(requests[0]!.body as object).sort()).toEqual(
      ["content_type", "description", "filename", "infer_lineage", "metadata", "project_id", "size_bytes", "tags", "title"],
    );
    expect((requests[0]!.body as { content_type: string }).content_type).toBe("application/x-custom");
  });

  it("returns after a single get with wait: false", async () => {
    const { c, requests } = client([json(TICKET, 201), ok(), ref(), json(artifact({ status: "processing" }))]);
    const out = await c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt", wait: false });
    expect(out.status).toBe("processing");
    expect(requests).toHaveLength(4);
  });

  it("raises ProcessingFailedError when the server cannot process the upload", async () => {
    const { c } = client([json(TICKET, 201), ok(), ref(), json(artifact({ status: "failed" }))]);
    await expect(c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt" })).rejects.toBeInstanceOf(ProcessingFailedError);
  });

  it("raises ProcessingTimeoutError carrying the artifact as it stands", async () => {
    const { c } = client([json(TICKET, 201), ok(), ref(), json(artifact({ status: "processing" }))]);
    const err = (await c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt", timeout_ms: 0 }).catch((e: unknown) => e)) as ProcessingTimeoutError;
    expect(err).toBeInstanceOf(ProcessingTimeoutError);
    expect(err.artifact?.status).toBe("processing");
  });

  it("completes nothing when storage refuses the bytes", async () => {
    const { c, requests } = client([json(TICKET, 201), new Response("denied", { status: 403 })]);
    const err = await c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(String(err)).not.toContain("SECRETSIG");
    expect(requests).toHaveLength(2);
  });

  it("streams a path source, framed by an explicit Content-Length", async () => {
    const path = join(dir, "hello.txt");
    writeFileSync(path, "hello");
    let sent = "";
    const put: Reply = async (req) => {
      sent = await new Response(req.init.body as BodyInit).text();
      return ok();
    };
    const { c, requests } = client([json(TICKET, 201), put, ref(), json(artifact())]);
    await c.artifacts.push(path, { title: "Hello" });
    expect(requests[0]!.body).toMatchObject({ filename: "hello.txt", content_type: "text/plain", size_bytes: 5 });
    expect(sent).toBe("hello");
    expect(requests[1]!.headers.get("content-length")).toBe("5");
    expect((requests[1]!.init as { duplex?: string }).duplex).toBe("half");
    expect(requests[2]!.body).toEqual({ sha256: HELLO_SHA256, size_bytes: 5 });
  });

  it("needs a filename for nameless bytes, before any request", async () => {
    const { c, requests } = client([]);
    await expect(c.artifacts.push(HELLO, { title: "Hello" })).rejects.toThrow(/filename is required/);
    expect(requests).toHaveLength(0);
  });
});

describe("createVersion", () => {
  it("reserves a version on the existing artifact, then uploads like push", async () => {
    const { c, requests } = client([json(TICKET, 201), ok(), ref(), json(artifact())]);
    await c.artifacts.createVersion(ARTIFACT_ID, HELLO, { filename: "hello.txt", run: "run-1" });
    expect(steps(requests)[0]).toBe(`POST api.test/v1/artifacts/${ARTIFACT_ID}/uploads`);
    expect(requests[0]!.body).toEqual({ filename: "hello.txt", content_type: "text/plain", size_bytes: 5, run_id: "run-1", infer_lineage: true });
    checkAgainstOpenApi(requests);
  });
});

describe("fulfil", () => {
  const create: Resolution = { status: "create", reservation: TICKET.artifact, upload: UPLOAD };

  it("uploads the bytes a resolve asked for and completes the reservation", async () => {
    const { c, requests } = client([ok(), ref(), json(artifact())]);
    const out = await c.artifacts.fulfil(create, HELLO);
    expect(out.status).toBe("ready");
    expect(steps(requests)).toEqual([
      "PUT storage.test/bucket/object",
      `POST api.test/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`,
      `GET api.test/v1/artifacts/${ARTIFACT_ID}`,
    ]);
  });

  it.each([
    ["hit", { status: "hit", artifact: artifact() } as Resolution],
    ["pending", { status: "pending", retry_after_seconds: 2 } as Resolution],
    ["create without an upload", { status: "create", reservation: TICKET.artifact } as Resolution],
  ])("refuses a %s resolution before any request", async (_name, resolution) => {
    const { c, requests } = client([]);
    await expect(c.artifacts.fulfil(resolution, HELLO)).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

describe("pull", () => {
  const bytes = () => new Response(HELLO);

  it("writes the signed version's bytes under its basename and returns the path", async () => {
    const { c, requests } = client([json(DOWNLOAD), json([VERSION_VIEW]), bytes()]);
    const out = await c.artifacts.pull(ARTIFACT_ID, dir + sep);
    expect(out).toBe(join(dir, "hello.txt"));
    expect(readFileSync(out, "utf8")).toBe("hello");
    expect(steps(requests)).toEqual([
      `GET api.test/v1/artifacts/${ARTIFACT_ID}/download`,
      `GET api.test/v1/artifacts/${ARTIFACT_ID}/versions`,
      "GET storage.test/bucket/object",
    ]);
    expect(requests[2]!.headers.get("authorization")).toBeNull();
    checkAgainstOpenApi(requests);
  });

  it("keeps a hostile server filename inside the destination", async () => {
    const { c } = client([json(DOWNLOAD), json([{ ...VERSION_VIEW, original_filename: "../../escape.txt" }]), bytes()]);
    expect(await c.artifacts.pull(ARTIFACT_ID, dir)).toBe(join(dir, "escape.txt"));
  });

  it("falls back to latest_version when the version list does not name the signed version", async () => {
    const { c } = client([json(DOWNLOAD), json([]), json(artifact()), bytes()]);
    expect(await c.artifacts.pull(ARTIFACT_ID, join(dir, "out.txt"))).toBe(join(dir, "out.txt"));
  });

  it("refuses to pair the bytes with another version's name, before touching storage", async () => {
    const other = { ...VERSION_VIEW, id: "another-version" };
    const { c, requests } = client([json(DOWNLOAD), json([other]), json(artifact({ latest_version: other }))]);
    const err = (await c.artifacts.pull(ARTIFACT_ID, dir).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err.code).toBe("version_mismatch");
    expect(requests).toHaveLength(3);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves no file on a digest mismatch, and verify: false skips the check", async () => {
    const tampered = () => new Response("tampered");
    const first = client([json(DOWNLOAD), json([VERSION_VIEW]), tampered()]);
    await expect(first.c.artifacts.pull(ARTIFACT_ID, dir)).rejects.toBeInstanceOf(IntegrityError);
    expect(readdirSync(dir)).toEqual([]);
    const second = client([json(DOWNLOAD), json([VERSION_VIEW]), tampered()]);
    const out = await second.c.artifacts.pull(ARTIFACT_ID, dir, { verify: false });
    expect(readFileSync(out, "utf8")).toBe("tampered");
  });
});

describe("pullBytes", () => {
  it("returns verified bytes with the version's description", async () => {
    const { c } = client([json(DOWNLOAD), json([VERSION_VIEW]), new Response(HELLO)]);
    const out = await c.artifacts.pullBytes(ARTIFACT_ID);
    expect(out).toEqual({ data: HELLO, filename: "hello.txt", content_type: "text/plain", version_id: VERSION_ID, sha256: HELLO_SHA256 });
  });

  it("raises IntegrityError on a mismatch", async () => {
    const { c } = client([json(DOWNLOAD), json([VERSION_VIEW]), new Response("tampered")]);
    await expect(c.artifacts.pullBytes(ARTIFACT_ID)).rejects.toBeInstanceOf(IntegrityError);
  });
});

// -- intent-surface spec §6: if_exists, max_age_seconds, by-key reads -----------------------

const KEYED = artifact({ external_key: "k/1", title: "Old title" });
const notFound = () => json({ type: "x", title: "nf", status: 404, detail: "no", code: "artifact_not_found" }, 404, { "content-type": "application/problem+json" });
const keyConflict = () => json({ type: "x", title: "c", status: 409, detail: "taken", code: "external_key_conflict" }, 409, { "content-type": "application/problem+json" });
const REUSE = { title: "Hello", filename: "hello.txt", external_key: "k/1", if_exists: "reuse" as const };
const create: Resolution = { status: "create", reservation: TICKET.artifact, upload: UPLOAD };

describe("push if_exists validation", () => {
  it("rejects if_exists without external_key, before any request", async () => {
    const { c, requests } = client([]);
    await expect(c.artifacts.push(HELLO, { title: "T", filename: "f.txt", if_exists: "version" })).rejects.toThrow(new TypeError("if_exists needs external_key"));
    expect(requests).toHaveLength(0);
  });

  it("rejects max_age_seconds unless reusing, before any request", async () => {
    const { c, requests } = client([]);
    await expect(c.artifacts.push(HELLO, { title: "T", filename: "f.txt", external_key: "k", max_age_seconds: 5 })).rejects.toThrow(
      new TypeError("max_age_seconds only applies with if_exists 'reuse'"),
    );
    await expect(c.artifacts.push(HELLO, { title: "T", filename: "f.txt", external_key: "k", if_exists: "version", max_age_seconds: 5 })).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });

  it("rejects an unknown if_exists, before any request", async () => {
    const { c, requests } = client([]);
    await expect(c.artifacts.push(HELLO, { title: "T", filename: "f.txt", external_key: "k", if_exists: "merge" as never })).rejects.toThrow(
      new TypeError("if_exists must be 'error', 'version' or 'reuse'"),
    );
    expect(requests).toHaveLength(0);
  });

  it("reports reused: false on a plain push", async () => {
    const { c } = client([json(TICKET, 201), ok(), ref(), json(artifact())]);
    expect((await c.artifacts.push(HELLO, { title: "Hello", filename: "hello.txt" })).reused).toBe(false);
  });
});

describe("push if_exists: reuse", () => {
  it("returns the existing artifact with reused, uploading nothing", async () => {
    const { c, requests } = client([json({ status: "hit", artifact: KEYED })]);
    const out = await c.artifacts.push(HELLO, { ...REUSE, max_age_seconds: 3600 });
    expect(out).toEqual({ ...KEYED, reused: true });
    expect(steps(requests)).toEqual(["POST api.test/v1/artifacts/resolve"]);
    expect(requests[0]!.body).toMatchObject({ external_key: "k/1", max_age_seconds: 3600, filename: "hello.txt", size_bytes: 5 });
    checkAgainstOpenApi(requests);
  });

  it("fulfils a create resolution; reused is false", async () => {
    const { c, requests } = client([json(create), ok(), ref(), json(artifact())]);
    const out = await c.artifacts.push(HELLO, REUSE);
    expect(out.reused).toBe(false);
    expect(steps(requests)).toEqual([
      "POST api.test/v1/artifacts/resolve",
      "PUT storage.test/bucket/object",
      `POST api.test/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`,
      `GET api.test/v1/artifacts/${ARTIFACT_ID}`,
    ]);
    checkAgainstOpenApi(requests);
  });

  it("PATCHes exactly expires_at after a reuse-create completes", async () => {
    const { c, requests } = client([json(create), ok(), ref(), json(artifact()), json(artifact())]);
    const when = new Date("2027-01-01T00:00:00Z");
    const out = await c.artifacts.push(HELLO, { ...REUSE, expires_at: when });
    expect(out.reused).toBe(false);
    const last = requests.at(-1)!;
    expect(`${last.method} ${last.url.pathname}`).toBe(`PATCH /v1/artifacts/${ARTIFACT_ID}`);
    expect(last.body).toEqual({ expires_at: when.toISOString() });
    expect(steps(requests).indexOf(`PATCH api.test/v1/artifacts/${ARTIFACT_ID}`)).toBeGreaterThan(
      steps(requests).indexOf(`POST api.test/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`),
    );
    checkAgainstOpenApi(requests);
  });

  it("issues no PATCH on a reuse hit even with expires_at", async () => {
    const { c, requests } = client([json({ status: "hit", artifact: KEYED })]);
    const out = await c.artifacts.push(HELLO, { ...REUSE, expires_at: new Date("2027-01-01T00:00:00Z") });
    expect(out.reused).toBe(true);
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("sleeps through pending, honouring retry_after_seconds capped at 5, then takes the hit", async () => {
    const slept: number[] = [];
    const fake = fakeFetch([json({ status: "pending", retry_after_seconds: 1 }), json({ status: "pending", retry_after_seconds: 60 }), json({ status: "pending" }), json({ status: "hit", artifact: KEYED })]);
    const c = new Artefaktum({ apiKey: "afk_test_key", baseUrl: "https://api.test", project: PROJECT_ID, fetch: fake.fetch }, { sleep: async (ms) => { slept.push(ms); } });
    const out = await c.artifacts.push(HELLO, REUSE);
    expect(out.reused).toBe(true);
    expect(slept).toEqual([1000, 5000, 2000]);
    checkAgainstOpenApi(fake.requests);
  });

  it("throws ProcessingTimeoutError once the pending budget is spent", async () => {
    const { c, requests } = client(Array.from({ length: 5 }, () => json({ status: "pending", retry_after_seconds: 2 })));
    const err = (await c.artifacts.push(HELLO, { ...REUSE, timeout_ms: 4000 }).catch((e: unknown) => e)) as ProcessingTimeoutError;
    expect(err).toBeInstanceOf(ProcessingTimeoutError);
    expect(err.message).toBe("resolve stayed pending for 4000 ms");
    expect(err.artifact).toBeUndefined();
    expect(requests).toHaveLength(3);
  });

  it("propagates StorageError from a failed fulfilment", async () => {
    const { c } = client([json(create), new Response("denied", { status: 403 })]);
    await expect(c.artifacts.push(HELLO, REUSE)).rejects.toBeInstanceOf(StorageError);
  });
});

describe("push if_exists: version", () => {
  const VERSION_OPTS = { title: "Hello", filename: "hello.txt", external_key: "k/1", if_exists: "version" as const };

  it("adds a version when the key exists, without a PATCH when nothing differs", async () => {
    const { c, requests } = client([json(KEYED), json(TICKET, 201), ok(), ref(), json(artifact())]);
    const out = await c.artifacts.push(HELLO, { ...VERSION_OPTS, title: "Old title" });
    expect(out.reused).toBe(false);
    expect(steps(requests)).toEqual([
      "GET api.test/v1/artifacts/by-external-key/k%2F1",
      `POST api.test/v1/artifacts/${ARTIFACT_ID}/uploads`,
      "PUT storage.test/bucket/object",
      `POST api.test/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`,
      `GET api.test/v1/artifacts/${ARTIFACT_ID}`,
    ]);
    checkAgainstOpenApi(requests);
  });

  it("applies the descriptor fields given with a PATCH afterwards", async () => {
    const { c, requests } = client([json(KEYED), json(TICKET, 201), ok(), ref(), json(artifact()), json(artifact({ title: "Hello" }))]);
    const out = await c.artifacts.push(HELLO, { ...VERSION_OPTS, description: "d", tags: ["a"], metadata: { m: 1 } });
    expect(out.title).toBe("Hello");
    const patch = requests.at(-1)!;
    expect(`${patch.method} ${patch.url.pathname}`).toBe(`PATCH /v1/artifacts/${ARTIFACT_ID}`);
    expect(patch.body).toEqual({ title: "Hello", description: "d", tags: ["a"], metadata: { m: 1 } });
    checkAgainstOpenApi(requests);
  });

  it("creates with the key when it is missing", async () => {
    const { c, requests } = client([notFound(), json(TICKET, 201), ok(), ref(), json(artifact())]);
    const out = await c.artifacts.push(HELLO, VERSION_OPTS);
    expect(out.reused).toBe(false);
    expect(steps(requests)[1]).toBe("POST api.test/v1/artifacts/uploads");
    expect(requests[1]!.body).toMatchObject({ external_key: "k/1" });
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
    checkAgainstOpenApi(requests);
  });

  it("retries the version path once when a concurrent writer wins the create", async () => {
    const { c, requests } = client([notFound(), keyConflict(), json(KEYED), json(TICKET, 201), ok(), ref(), json(artifact()), json(artifact())]);
    await c.artifacts.push(HELLO, VERSION_OPTS);
    expect(steps(requests).slice(0, 4)).toEqual([
      "GET api.test/v1/artifacts/by-external-key/k%2F1",
      "POST api.test/v1/artifacts/uploads",
      "GET api.test/v1/artifacts/by-external-key/k%2F1",
      `POST api.test/v1/artifacts/${ARTIFACT_ID}/uploads`,
    ]);
  });

  it("gives up after the one retry", async () => {
    const { c, requests } = client([notFound(), keyConflict(), notFound(), keyConflict()]);
    const err = (await c.artifacts.push(HELLO, VERSION_OPTS).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err.code).toBe("external_key_conflict");
    expect(requests).toHaveLength(4);
  });
});

describe("by-key reads", () => {
  it("getByExternalKey sends max_age_seconds, and omits it when undefined", async () => {
    const { c, requests } = client([json(KEYED), json(KEYED)]);
    await c.artifacts.getByExternalKey("k/1", { max_age_seconds: 3600 });
    await c.artifacts.getByExternalKey("k/1");
    expect(requests[0]!.url.searchParams.get("max_age_seconds")).toBe("3600");
    expect(requests[1]!.url.searchParams.has("max_age_seconds")).toBe(false);
    checkAgainstOpenApi(requests);
  });

  it("pullByKey fetches by key then pulls, naming the file after the version", async () => {
    const { c, requests } = client([json(KEYED), json(DOWNLOAD), json([VERSION_VIEW]), new Response(HELLO)]);
    const out = await c.artifacts.pullByKey("k/1", dir + sep, { max_age_seconds: 60 });
    expect(out).toBe(join(dir, "hello.txt"));
    expect(requests[0]!.url.searchParams.get("max_age_seconds")).toBe("60");
    expect(steps(requests)[1]).toBe(`GET api.test/v1/artifacts/${ARTIFACT_ID}/download`);
    checkAgainstOpenApi(requests);
  });

  it("pullBytesByKey returns the verified bytes", async () => {
    const { c } = client([json(KEYED), json(DOWNLOAD), json([VERSION_VIEW]), new Response(HELLO)]);
    expect((await c.artifacts.pullBytesByKey("k/1")).data).toEqual(HELLO);
  });
});
