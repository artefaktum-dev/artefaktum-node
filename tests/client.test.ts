import { describe, expect, it } from "vitest";
import { Artefaktum } from "../src/client.js";
import { MissingApiKeyError, NotFoundError } from "../src/errors.js";
import { ARTIFACT, ARTIFACT_ID, DOWNLOAD, PROJECTS, PROJECT_ID, TICKET, VERSION_ID, VERSION_VIEW } from "./fixtures.js";
import { type Reply, empty, fakeFetch, json, problem } from "./helpers.js";
import { allOperations, assertInOpenApi } from "./openapi.js";

function client(replies: Reply[], options: { project?: string } = {}) {
  const fake = fakeFetch(replies);
  const c = new Artefaktum(
    { apiKey: "afk_test_key", baseUrl: "https://api.test", project: options.project ?? PROJECT_ID, fetch: fake.fetch },
    { sleep: async () => undefined },
  );
  return { c, ...fake };
}

const RUN = { id: "run-1", project_id: PROJECT_ID, created_by: "key:test", sealed_at: null, created_at: "2026-09-21T10:00:00Z" };
const KEY = { id: "key-1", name: "ci", project_id: null, scopes: ["artifacts:read"], last_used_at: null, expires_at: null, revoked_at: null, created_at: "2026-09-21T10:00:00Z" };
const RELATION = {
  id: "rel-1", direction: "outgoing", relation_type: "derived_from", origin: "explicit", from_artifact_id: ARTIFACT_ID,
  from_version_id: null, to_artifact_id: "a2", to_version_id: null, run_id: null, metadata: {}, created_at: "2026-09-21T10:00:00Z",
};
const QUOTA = { plan: "free", storage: { used_bytes: 5, limit_bytes: 1_073_741_824 }, calls: { used: 1, limit: 10_000, resets_at: "2026-10-01T00:00:00Z" }, max_file_bytes: 104_857_600 };
const PAGE = { items: [ARTIFACT], next_cursor: null };

interface Case {
  name: string;
  call: (c: Artefaktum) => Promise<unknown>;
  reply: () => Response;
  method: string;
  path: string;
  query?: Array<[string, string]>;
  body?: unknown;
  result: unknown;
}

const CASES: Case[] = [
  { name: "whoami", call: (c) => c.whoami(), reply: () => json({ tenant_id: "t1", project_id: null }), method: "GET", path: "/health/whoami", result: { tenant_id: "t1", project_id: null } },
  { name: "quota", call: (c) => c.quota(), reply: () => json(QUOTA), method: "GET", path: "/v1/quota", result: QUOTA },
  { name: "projects.list unwraps items", call: (c) => c.projects.list(), reply: () => json({ items: PROJECTS }), method: "GET", path: "/v1/projects", result: PROJECTS },
  {
    name: "artifacts.createUpload applies the defaults the server would",
    call: (c) => c.artifacts.createUpload({ filename: "hello.txt", content_type: "text/plain", size_bytes: 5, title: "Hello" }),
    reply: () => json(TICKET, 201), method: "POST", path: "/v1/artifacts/uploads",
    body: { project_id: PROJECT_ID, filename: "hello.txt", content_type: "text/plain", size_bytes: 5, title: "Hello", description: "", tags: [], metadata: {}, infer_lineage: true },
    result: TICKET,
  },
  {
    name: "artifacts.createUpload sends every field, run as run_id, a Date as ISO",
    call: (c) => c.artifacts.createUpload({
      filename: "r.pdf", content_type: "application/pdf", size_bytes: 9, title: "R", description: "d", tags: ["a", "b"], metadata: { k: 1 },
      external_key: "reports/q3", expires_at: new Date("2026-12-31T00:00:00Z"), summary: "s", run: "run-1", infer_lineage: false,
    }),
    reply: () => json(TICKET, 201), method: "POST", path: "/v1/artifacts/uploads",
    body: {
      project_id: PROJECT_ID, filename: "r.pdf", content_type: "application/pdf", size_bytes: 9, title: "R", description: "d", tags: ["a", "b"], metadata: { k: 1 },
      external_key: "reports/q3", expires_at: "2026-12-31T00:00:00.000Z", summary: "s", run_id: "run-1", infer_lineage: false,
    },
    result: TICKET,
  },
  {
    name: "artifacts.completeUpload", call: (c) => c.artifacts.completeUpload(ARTIFACT_ID, VERSION_ID, { sha256: "abc", size_bytes: 5 }),
    reply: () => json(TICKET.artifact), method: "POST", path: `/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`,
    body: { sha256: "abc", size_bytes: 5 }, result: TICKET.artifact,
  },
  {
    name: "artifacts.completeUpload with nothing to report still sends a JSON object", call: (c) => c.artifacts.completeUpload(ARTIFACT_ID, VERSION_ID),
    reply: () => json(TICKET.artifact), method: "POST", path: `/v1/artifacts/${ARTIFACT_ID}/versions/${VERSION_ID}/complete`, body: {}, result: TICKET.artifact,
  },
  { name: "artifacts.get", call: (c) => c.artifacts.get(ARTIFACT_ID), reply: () => json(ARTIFACT), method: "GET", path: `/v1/artifacts/${ARTIFACT_ID}`, result: ARTIFACT },
  {
    name: "artifacts.getByExternalKey encodes slashes in the key", call: (c) => c.artifacts.getByExternalKey("reports/q3 final"),
    reply: () => json(ARTIFACT), method: "GET", path: "/v1/artifacts/by-external-key/reports%2Fq3%20final", query: [["project_id", PROJECT_ID]], result: ARTIFACT,
  },
  {
    name: "artifacts.list with defaults", call: (c) => c.artifacts.list(), reply: () => json(PAGE), method: "GET", path: "/v1/artifacts",
    query: [["project_id", PROJECT_ID], ["limit", "50"]], result: PAGE,
  },
  {
    name: "artifacts.list repeats status and sends filters",
    call: (c) => c.artifacts.list({ status: ["ready", "failed"], tag: "churn", content_type: "text/csv", external_key: "k", created_after: new Date("2026-01-01T00:00:00Z"), created_before: "2026-02-01T00:00:00Z", expires_before: "2026-03-01T00:00:00Z", limit: 10, cursor: "c1" }),
    reply: () => json(PAGE), method: "GET", path: "/v1/artifacts",
    query: [["project_id", PROJECT_ID], ["status", "ready"], ["status", "failed"], ["content_type", "text/csv"], ["tag", "churn"], ["external_key", "k"], ["created_before", "2026-02-01T00:00:00Z"], ["created_after", "2026-01-01T00:00:00.000Z"], ["expires_before", "2026-03-01T00:00:00Z"], ["limit", "10"], ["cursor", "c1"]],
    result: PAGE,
  },
  {
    name: "artifacts.list accepts one status as a string", call: (c) => c.artifacts.list({ status: "ready" }), reply: () => json(PAGE), method: "GET", path: "/v1/artifacts",
    query: [["project_id", PROJECT_ID], ["status", "ready"], ["limit", "50"]], result: PAGE,
  },
  {
    name: "artifacts.search with defaults omits filters", call: (c) => c.artifacts.search("q3 churn"),
    reply: () => json({ items: [], next_cursor: null, mode: "hybrid" }), method: "POST", path: "/v1/artifacts/search",
    body: { project_id: PROJECT_ID, query: "q3 churn", mode: "hybrid", limit: 20 }, result: { items: [], next_cursor: null, mode: "hybrid" },
  },
  {
    name: "artifacts.search nests the filters and drops empty lists",
    call: (c) => c.artifacts.search("", { mode: "text", limit: 5, cursor: "c", content_types: ["text/csv"], tags_all: [], status: "ready", external_key: "k", created_after: "2026-01-01T00:00:00Z", exclude_superseded: false }),
    reply: () => json({ items: [], next_cursor: null, mode: "text" }), method: "POST", path: "/v1/artifacts/search",
    body: { project_id: PROJECT_ID, query: "", mode: "text", limit: 5, cursor: "c", filters: { content_types: ["text/csv"], status: ["ready"], external_key: "k", created_after: "2026-01-01T00:00:00Z", exclude_superseded: false } },
    result: { items: [], next_cursor: null, mode: "text" },
  },
  {
    name: "artifacts.resolve", call: (c) => c.artifacts.resolve("api/openweather/2026-09-21", { filename: "w.json", content_type: "application/json", size_bytes: 10, title: "Weather", max_age_seconds: 3600, run: "run-1" }),
    reply: () => json({ status: "pending", retry_after_seconds: 2 }), method: "POST", path: "/v1/artifacts/resolve",
    body: { project_id: PROJECT_ID, external_key: "api/openweather/2026-09-21", max_age_seconds: 3600, filename: "w.json", content_type: "application/json", size_bytes: 10, title: "Weather", description: "", tags: [], metadata: {}, run_id: "run-1" },
    result: { status: "pending", retry_after_seconds: 2 },
  },
  {
    name: "artifacts.downloadUrl", call: (c) => c.artifacts.downloadUrl(ARTIFACT_ID, { version_id: VERSION_ID, run: "run-1" }), reply: () => json(DOWNLOAD), method: "GET",
    path: `/v1/artifacts/${ARTIFACT_ID}/download`, query: [["version_id", VERSION_ID], ["run_id", "run-1"]], result: DOWNLOAD,
  },
  {
    name: "artifacts.update sends only what was given", call: (c) => c.artifacts.update(ARTIFACT_ID, { title: "New", tags: [] }), reply: () => json(ARTIFACT), method: "PATCH",
    path: `/v1/artifacts/${ARTIFACT_ID}`, body: { title: "New", tags: [] }, result: ARTIFACT,
  },
  {
    name: "artifacts.update sends clear_expires_at only when true", call: (c) => c.artifacts.update(ARTIFACT_ID, { clear_expires_at: true }), reply: () => json(ARTIFACT), method: "PATCH",
    path: `/v1/artifacts/${ARTIFACT_ID}`, body: { clear_expires_at: true }, result: ARTIFACT,
  },
  {
    name: "artifacts.update drops a false clear_expires_at", call: (c) => c.artifacts.update(ARTIFACT_ID, { description: "d", clear_expires_at: false }), reply: () => json(ARTIFACT), method: "PATCH",
    path: `/v1/artifacts/${ARTIFACT_ID}`, body: { description: "d" }, result: ARTIFACT,
  },
  {
    name: "artifacts.addRelation", call: (c) => c.artifacts.addRelation(ARTIFACT_ID, "a2", "derived_from", { to_version_id: "v2", metadata: { why: "x" } }), reply: () => json(RELATION, 201), method: "POST",
    path: `/v1/artifacts/${ARTIFACT_ID}/relations`, body: { to_artifact_id: "a2", relation_type: "derived_from", to_version_id: "v2", metadata: { why: "x" } }, result: RELATION,
  },
  { name: "artifacts.relations", call: (c) => c.artifacts.relations(ARTIFACT_ID), reply: () => json([RELATION]), method: "GET", path: `/v1/artifacts/${ARTIFACT_ID}/relations`, result: [RELATION] },
  { name: "artifacts.versions", call: (c) => c.artifacts.versions(ARTIFACT_ID), reply: () => json([VERSION_VIEW]), method: "GET", path: `/v1/artifacts/${ARTIFACT_ID}/versions`, result: [VERSION_VIEW] },
  { name: "artifacts.delete resolves to undefined on 202", call: (c) => c.artifacts.delete(ARTIFACT_ID), reply: () => empty(202), method: "DELETE", path: `/v1/artifacts/${ARTIFACT_ID}`, result: undefined },
  { name: "runs.create", call: (c) => c.runs.create({ run_id: "run-1" }), reply: () => json(RUN, 201), method: "POST", path: "/v1/runs", body: { project_id: PROJECT_ID, run_id: "run-1" }, result: RUN },
  { name: "runs.create without an id", call: (c) => c.runs.create(), reply: () => json(RUN, 201), method: "POST", path: "/v1/runs", body: { project_id: PROJECT_ID }, result: RUN },
  { name: "runs.seal sends no body", call: (c) => c.runs.seal("run-1"), reply: () => json(RUN), method: "POST", path: "/v1/runs/run-1/seal", result: RUN },
  { name: "runs.artifacts", call: (c) => c.runs.artifacts("run-1", { limit: 5, cursor: "c" }), reply: () => json(PAGE), method: "GET", path: "/v1/runs/run-1/artifacts", query: [["limit", "5"], ["cursor", "c"]], result: PAGE },
  {
    name: "keys.create without a project mints a tenant-wide key", call: (c) => c.keys.create("ci", ["artifacts:read"]), reply: () => json({ key: KEY, secret: "afk_secret" }, 201), method: "POST",
    path: "/v1/api-keys", body: { name: "ci", scopes: ["artifacts:read"] }, result: { key: KEY, secret: "afk_secret" },
  },
  {
    name: "keys.create with a project and an expiry", call: (c) => c.keys.create("ci", ["artifacts:read"], { project: PROJECT_ID, expires_at: "2027-01-01T00:00:00Z" }), reply: () => json({ key: KEY, secret: "s" }, 201), method: "POST",
    path: "/v1/api-keys", body: { name: "ci", scopes: ["artifacts:read"], project_id: PROJECT_ID, expires_at: "2027-01-01T00:00:00Z" }, result: { key: KEY, secret: "s" },
  },
  { name: "keys.list", call: (c) => c.keys.list(), reply: () => json([KEY]), method: "GET", path: "/v1/api-keys", result: [KEY] },
  { name: "keys.revoke", call: (c) => c.keys.revoke("key-1"), reply: () => json(KEY), method: "DELETE", path: "/v1/api-keys/key-1", result: KEY },
  {
    name: "usage.get defaults to days, the whole tenant, and unwraps items", call: (c) => c.usage.get(), reply: () => json({ granularity: "day", items: [{ bucket_start: "2026-09-21T00:00:00Z", metric: "requests", value: 3 }] }), method: "GET",
    path: "/v1/usage", query: [["granularity", "day"]], result: [{ bucket_start: "2026-09-21T00:00:00Z", metric: "requests", value: 3 }],
  },
  {
    name: "usage.get with every filter", call: (c) => c.usage.get({ start: "2026-09-01T00:00:00Z", end: new Date("2026-09-21T00:00:00Z"), granularity: "hour", metric: "requests", project: PROJECT_ID, principal_id: "key-1" }),
    reply: () => json({ granularity: "hour", items: [] }), method: "GET", path: "/v1/usage",
    query: [["start", "2026-09-01T00:00:00Z"], ["end", "2026-09-21T00:00:00.000Z"], ["granularity", "hour"], ["metric", "requests"], ["project_id", PROJECT_ID], ["principal_id", "key-1"]], result: [],
  },
];

/** Populated by "every operation" below; checked against openapi.json's full surface after. */
const exercised = new Set<string>();

describe("every operation", () => {
  it.each(CASES)("$name", async ({ call, reply, method, path, query, body, result }) => {
    const { c, requests } = client([reply()]);
    expect(await call(c)).toEqual(result);
    expect(requests).toHaveLength(1);
    const [req] = requests;
    expect(req!.method).toBe(method);
    expect(req!.url.origin).toBe("https://api.test");
    expect(req!.url.pathname).toBe(path);
    expect([...req!.url.searchParams.entries()]).toEqual(query ?? []);
    expect(req!.body).toEqual(body);
    expect(req!.headers.get("authorization")).toBe("Bearer afk_test_key");
    exercised.add(assertInOpenApi(req!));
  });
});

describe("openapi coverage", () => {
  // GET /health/live and GET /health/ready aren't part of the SDK surface; POST
  // /v1/artifacts/{artifact_id}/uploads is exercised by createVersion in push-pull.test.ts.
  const ALLOWED_UNEXERCISED = new Set(["GET /health/live", "GET /health/ready", "POST /v1/artifacts/{artifact_id}/uploads"]);

  it("exercises every OpenAPI operation except the documented exceptions", () => {
    const expected = allOperations();
    for (const id of ALLOWED_UNEXERCISED) expected.delete(id);
    expect(exercised).toEqual(expected);
  });
});

describe("search is retried like a read", () => {
  it("retries on 503", async () => {
    const { c, requests } = client([problem(503, "x"), json({ items: [], next_cursor: null, mode: "hybrid" })]);
    await c.artifacts.search("q");
    expect(requests).toHaveLength(2);
  });
});

describe("iterAll", () => {
  it("follows next_cursor and resolves the project once", async () => {
    const a = (id: string) => ({ ...ARTIFACT, id });
    const { c, requests } = client(
      [json({ items: PROJECTS }), json({ items: [a("1"), a("2")], next_cursor: "c2" }), json({ items: [a("3")], next_cursor: null })],
      { project: "default" },
    );
    const ids: string[] = [];
    for await (const item of c.artifacts.iterAll({ tag: "t", limit: 2 })) ids.push(item.id);
    expect(ids).toEqual(["1", "2", "3"]);
    expect(requests.map((r) => r.url.pathname)).toEqual(["/v1/projects", "/v1/artifacts", "/v1/artifacts"]);
    expect(requests[1]!.url.searchParams.get("cursor")).toBeNull();
    expect(requests[2]!.url.searchParams.get("cursor")).toBe("c2");
    expect(requests[2]!.url.searchParams.get("tag")).toBe("t");
  });
});

describe("addRelation", () => {
  it("rejects an unknown relation type before any request", async () => {
    const { c, requests } = client([]);
    // @ts-expect-error not a RelationType
    await expect(c.artifacts.addRelation(ARTIFACT_ID, "a2", "inspired_by")).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});

describe("project resolution", () => {
  it("uses a UUID as given, with no lookup", async () => {
    const { c, requests } = client([json(PAGE)]);
    await c.artifacts.list();
    expect(requests.map((r) => r.url.pathname)).toEqual(["/v1/artifacts"]);
  });

  it("resolves the default slug once, even under concurrency, and caches it", async () => {
    const { c, requests } = client([json({ items: PROJECTS }), json(PAGE), json(PAGE), json(PAGE)], { project: "default" });
    await Promise.all([c.artifacts.list(), c.artifacts.list()]);
    await c.artifacts.list();
    expect(requests.filter((r) => r.url.pathname === "/v1/projects")).toHaveLength(1);
    expect(requests.filter((r) => r.url.pathname === "/v1/artifacts").every((r) => r.url.searchParams.get("project_id") === PROJECT_ID)).toBe(true);
  });

  it("resolves a per-call override every time and leaves the default alone", async () => {
    const { c, requests } = client([json({ items: PROJECTS }), json(PAGE), json({ items: PROJECTS }), json(PAGE), json(PAGE)]);
    await c.artifacts.list({ project: "research" });
    await c.artifacts.list({ project: "research" });
    await c.artifacts.list();
    expect(requests.filter((r) => r.url.pathname === "/v1/projects")).toHaveLength(2);
    expect(requests[1]!.url.searchParams.get("project_id")).toBe(PROJECTS[1]!.id);
    expect(requests[4]!.url.searchParams.get("project_id")).toBe(PROJECT_ID);
  });

  it("names the slug and what exists when the slug is unknown", async () => {
    const { c } = client([json({ items: PROJECTS })], { project: "nope" });
    const err = (await c.artifacts.list().catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe("project_not_found");
    expect(err.message).toBe('no project with slug "nope"; available: ["default","research"]');
  });

  it("does not cache a failed lookup", async () => {
    const { c, requests } = client([problem(500, "internal"), json({ items: PROJECTS }), json(PAGE)], { project: "default" });
    await expect(c.artifacts.list()).rejects.toMatchObject({ status: 500 });
    await c.artifacts.list();
    expect(requests.filter((r) => r.url.pathname === "/v1/projects")).toHaveLength(2);
  });

  it("does not apply the default project to keys.create or usage.get", async () => {
    const { c, requests } = client([json({ key: KEY, secret: "s" }, 201), json({ granularity: "day", items: [] })], { project: "default" });
    await c.keys.create("ci", ["artifacts:read"]);
    await c.usage.get();
    expect(requests.map((r) => r.url.pathname)).toEqual(["/v1/api-keys", "/v1/usage"]);
  });
});

describe("construction", () => {
  it("throws MissingApiKeyError before any request", () => {
    const before = process.env.ARTEFAKTUM_API_KEY;
    delete process.env.ARTEFAKTUM_API_KEY;
    try {
      expect(() => new Artefaktum()).toThrow(MissingApiKeyError);
    } finally {
      if (before !== undefined) process.env.ARTEFAKTUM_API_KEY = before;
    }
  });
});
