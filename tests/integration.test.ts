/**
 * Round trip against a live stack (design spec §11). Skipped unless
 * ARTEFAKTUM_TEST_BASE_URL and ARTEFAKTUM_TEST_API_KEY are set. This is the only test file
 * that reaches a real API; everything else runs offline.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Artefaktum, NotFoundError } from "../src/index.js";

const BASE = process.env.ARTEFAKTUM_TEST_BASE_URL;
const KEY = process.env.ARTEFAKTUM_TEST_API_KEY;

describe.skipIf(!BASE || !KEY)("live round trip", () => {
  const body = Buffer.from("hello from the typescript sdk integration test\n".repeat(100));
  const sha256 = createHash("sha256").update(body).digest("hex");
  const marker = `sdk-ts-${Date.now()}`;
  let dir: string;
  let client: Artefaktum;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "artefaktum-live-"));
    client = new Artefaktum({ apiKey: KEY, baseUrl: BASE });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("pushes, finds, pulls, versions and deletes", async () => {
    const src = join(dir, "hello.txt");
    writeFileSync(src, body);

    const run = await client.runs.create();

    const a = await client.artifacts.push(src, { title: `sdk-ts integration ${marker}`, tags: ["sdk-test", marker], timeout_ms: 60_000, run: run.id });
    expect(a.status).toBe("ready");
    expect(a.latest_version?.sha256).toBe(sha256);
    expect(a.latest_version?.size_bytes).toBe(body.length);

    expect((await client.runs.artifacts(run.id)).items.some((x) => x.id === a.id)).toBe(true);
    const sealed = await client.runs.seal(run.id);
    expect(typeof sealed.sealed_at).toBe("string");

    expect((await client.projects.list()).some((p) => p.slug === "default")).toBe(true);
    expect(typeof (await client.whoami()).tenant_id).toBe("string");
    expect((await client.whoami()).tenant_id.length).toBeGreaterThan(0);
    const usage = await client.usage.get({ granularity: "day" });
    expect(Array.isArray(usage)).toBe(true);

    const page = await client.artifacts.search(marker, { mode: "text" });
    expect(page.items.some((hit) => hit.artifact.id === a.id)).toBe(true);

    const listed: string[] = [];
    for await (const item of client.artifacts.iterAll({ tag: marker })) listed.push(item.id);
    expect(listed).toEqual([a.id]);

    const out = await client.artifacts.pull(a.id, join(dir, "out") + sep);
    expect(out).toBe(join(dir, "out", "hello.txt"));
    expect(readFileSync(out).equals(body)).toBe(true);

    const pulled = await client.artifacts.pullBytes(a.id);
    expect(Buffer.from(pulled.data).equals(body)).toBe(true);
    expect(pulled.filename).toBe("hello.txt");

    const v2 = await client.artifacts.createVersion(a.id, new TextEncoder().encode("second version"), { filename: "hello-v2.txt", timeout_ms: 60_000 });
    expect(v2.latest_version?.version_number).toBe(2);
    expect(await client.artifacts.versions(a.id)).toHaveLength(2);

    const quota = await client.quota();
    expect(quota.storage.used_bytes).toBeGreaterThan(0);

    await client.artifacts.delete(a.id);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      try {
        await client.artifacts.get(a.id);
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
        gone = true;
      }
    }
    expect(gone).toBe(true);
  }, 120_000);
});
