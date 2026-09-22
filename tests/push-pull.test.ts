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
    expect(err.artifact.status).toBe("processing");
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
    await c.artifacts.createVersion(ARTIFACT_ID, HELLO, { filename: "hello.txt", summary: "v2", run: "run-1" });
    expect(steps(requests)[0]).toBe(`POST api.test/v1/artifacts/${ARTIFACT_ID}/uploads`);
    expect(requests[0]!.body).toEqual({ filename: "hello.txt", content_type: "text/plain", size_bytes: 5, summary: "v2", run_id: "run-1", infer_lineage: true });
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
