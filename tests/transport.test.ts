import { describe, expect, it, vi } from "vitest";
import { ArtefaktumError, ConnectionError, NotFoundError, QuotaExceededError } from "../src/errors.js";
import { Transport, buildUrl } from "../src/transport.js";
import { VERSION } from "../src/version.js";
import { CONFIG, empty, fakeFetch, json, problem } from "./helpers.js";

function transport(replies: Parameters<typeof fakeFetch>[0]) {
  const fake = fakeFetch(replies);
  const sleeps: number[] = [];
  const t = new Transport(CONFIG, fake.fetch, async (ms) => void sleeps.push(ms));
  return { t, sleeps, ...fake };
}

describe("buildUrl", () => {
  it("drops null and undefined, repeats arrays, encodes values", () => {
    const url = buildUrl("https://api.test", "/v1/artifacts", {
      project_id: "p1", status: ["ready", "failed"], tag: undefined, cursor: null, limit: 50, q: "a b&c",
    });
    expect(url).toBe("https://api.test/v1/artifacts?project_id=p1&status=ready&status=failed&limit=50&q=a+b%26c");
  });

  it("adds no question mark without a query", () => {
    expect(buildUrl("https://api.test", "/v1/projects")).toBe("https://api.test/v1/projects");
    expect(buildUrl("https://api.test", "/v1/projects", { a: undefined })).toBe("https://api.test/v1/projects");
  });
});

describe("Transport.request", () => {
  it("sends the bearer key, a user agent and a JSON body", async () => {
    const { t, requests } = transport([json({ ok: true })]);
    const out = await t.request<{ ok: boolean }>({ method: "POST", path: "/v1/runs", body: { project_id: "p1" } });
    expect(out).toEqual({ ok: true });
    const [req] = requests;
    expect(req!.method).toBe("POST");
    expect(req!.url.href).toBe("https://api.test/v1/runs");
    expect(req!.headers.get("authorization")).toBe("Bearer afk_test_key");
    expect(req!.headers.get("user-agent")).toBe(`artefaktum-node/${VERSION}`);
    expect(req!.headers.get("content-type")).toBe("application/json");
    expect(req!.body).toEqual({ project_id: "p1" });
    expect(req!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends no content-type and no body on a GET", async () => {
    const { t, requests } = transport([json([])]);
    await t.request({ method: "GET", path: "/v1/api-keys" });
    expect(requests[0]!.headers.get("content-type")).toBeNull();
    expect(requests[0]!.init.body).toBeUndefined();
  });

  it("returns undefined for an empty 2xx body", async () => {
    const { t } = transport([empty(202)]);
    expect(await t.request({ method: "DELETE", path: "/v1/artifacts/a1" })).toBeUndefined();
  });

  it("maps a problem body to its error class", async () => {
    const { t } = transport([problem(404, "artifact_not_found", "no such artifact")]);
    const err = await t.request({ method: "GET", path: "/v1/artifacts/a1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).request_id).toBe("req_test");
    expect((err as NotFoundError).status).toBe(404);
  });

  it("maps a non-JSON error body to http_error", async () => {
    const { t } = transport([new Response("<html>nope</html>", { status: 500, statusText: "Internal Server Error" })]);
    const err = (await t.request({ method: "POST", path: "/v1/runs", body: {} }).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err.code).toBe("http_error");
    expect(err.message).toBe("500 Internal Server Error");
  });

  it("maps a 2xx that is not JSON to http_error", async () => {
    const { t } = transport([new Response("<html>captive portal</html>", { status: 200, statusText: "OK" })]);
    const err = (await t.request({ method: "POST", path: "/v1/runs", body: {} }).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err).toBeInstanceOf(ArtefaktumError);
    expect(err.code).toBe("http_error");
    expect(err.status).toBe(200);
  });

  it("maps a 2xx that is not JSON to http_error on a GET too, and does not retry it", async () => {
    const { t, requests } = transport([new Response("<html>captive portal</html>", { status: 200, statusText: "OK" })]);
    const err = (await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err).toBeInstanceOf(ArtefaktumError);
    expect(err.code).toBe("http_error");
    expect(requests).toHaveLength(1);
  });
});

/** A `Response` whose body stream enqueues a fragment, then errors -- a connection dropped mid-body. */
function brokenBody(status = 200): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":'));
        controller.error(new TypeError("terminated"));
      },
    }),
    { status },
  );
}

describe("a failure reading the response body", () => {
  it("retries a GET whose first body read fails, and succeeds on the second reply", async () => {
    const { t, sleeps, requests } = transport([brokenBody(), json({ items: [] })]);
    expect(await t.request({ method: "GET", path: "/v1/projects" })).toEqual({ items: [] });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it("throws ConnectionError, with the original cause, when the body read fails on all three attempts", async () => {
    const { t, requests } = transport([brokenBody(), brokenBody(), brokenBody()]);
    const err = (await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e)) as ConnectionError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.code).toBe("connection_error");
    expect(requests).toHaveLength(3);
    expect((err.cause as TypeError).message).toBe("terminated");
  });

  it("throws ConnectionError after exactly one request for a write", async () => {
    const { t, requests } = transport([brokenBody()]);
    const err = await t.request({ method: "POST", path: "/v1/runs", body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(requests).toHaveLength(1);
  });

  it("does not re-wrap or retry the http_error from a 2xx that is not JSON", async () => {
    // Guards against the fix conflating "body read threw" with "body read succeeded but
    // decode() itself raised http_error" -- the latter must pass straight through.
    const { t, requests } = transport([new Response("<html>nope</html>", { status: 200, statusText: "OK" })]);
    const err = (await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err.code).toBe("http_error");
    expect(requests).toHaveLength(1);
  });
});

describe("a real dropped connection", () => {
  it("surfaces as ConnectionError after three attempts against a real socket", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-length": "9999" });
      res.write('{"a":');
      res.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const config = { apiKey: "k", baseUrl: `http://127.0.0.1:${port}`, project: "default", timeoutMs: 5_000 };
      const t = new Transport(config, undefined, async () => undefined);
      const err = (await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e)) as ConnectionError;
      expect(err).toBeInstanceOf(ConnectionError);
      expect(err.code).toBe("connection_error");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("retries", () => {
  it("retries a GET on 503, 0.5 s then 1 s, and gives up after three attempts", async () => {
    const { t, sleeps, requests } = transport([problem(503, "x"), problem(503, "x"), problem(503, "x")]);
    const err = (await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e)) as ArtefaktumError;
    expect(err.status).toBe(503);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it.each([429, 502, 503, 504])("retries a GET on %i and then succeeds", async (status) => {
    const { t, requests } = transport([problem(status, "x"), json({ items: [] })]);
    expect(await t.request({ method: "GET", path: "/v1/projects" })).toEqual({ items: [] });
    expect(requests).toHaveLength(2);
  });

  it("honours Retry-After in whole seconds", async () => {
    const { t, sleeps } = transport([problem(429, "rate_limited", "slow down", { "retry-after": "7" }), json({})]);
    await t.request({ method: "GET", path: "/v1/projects" });
    expect(sleeps).toEqual([7000]);
  });

  it("caps a long Retry-After: a server asking for an hour does not park the caller", async () => {
    const { t, sleeps } = transport([problem(503, "x", "x", { "retry-after": "3600" }), json({})]);
    await t.request({ method: "GET", path: "/v1/projects" });
    expect(sleeps).toEqual([10_000]);
  });

  it("ignores a Retry-After that is not whole seconds", async () => {
    const { t, sleeps } = transport([problem(503, "x", "x", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }), json({})]);
    await t.request({ method: "GET", path: "/v1/projects" });
    expect(sleeps).toEqual([500]);
  });

  it("never retries a spent quota", async () => {
    const { t, requests, sleeps } = transport([problem(429, "quota_exceeded", "monthly call limit reached")]);
    const err = await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not retry a 404", async () => {
    const { t, requests } = transport([problem(404, "artifact_not_found")]);
    await t.request({ method: "GET", path: "/v1/artifacts/a1" }).catch(() => undefined);
    expect(requests).toHaveLength(1);
  });

  it("never retries a write", async () => {
    const { t, requests } = transport([problem(503, "x")]);
    await t.request({ method: "POST", path: "/v1/runs", body: {} }).catch(() => undefined);
    expect(requests).toHaveLength(1);
  });

  it("retries a POST that is marked idempotent", async () => {
    const { t, requests } = transport([problem(503, "x"), json({ items: [] })]);
    await t.request({ method: "POST", path: "/v1/artifacts/search", body: {}, idempotent: true });
    expect(requests).toHaveLength(2);
  });

  it("retries a GET after a network failure", async () => {
    const { t, requests, sleeps } = transport([new TypeError("fetch failed"), json({ items: [] })]);
    expect(await t.request({ method: "GET", path: "/v1/projects" })).toEqual({ items: [] });
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  it("wraps a network failure that outlives the retries, naming the host only", async () => {
    const cause = new TypeError("fetch failed");
    const { t, requests } = transport([cause, cause, cause]);
    const err = (await t.request({ method: "GET", path: "/v1/projects" }).catch((e: unknown) => e)) as ConnectionError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toBe("could not reach api.test");
    expect(err.cause).toBe(cause);
    expect(requests).toHaveLength(3);
  });

  it("does not retry a network failure on a write", async () => {
    const { t, requests } = transport([new TypeError("fetch failed")]);
    const err = await t.request({ method: "POST", path: "/v1/runs", body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect(requests).toHaveLength(1);
  });

  it("reports a timeout as such", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { t } = transport([timeout]);
    const err = (await t.request({ method: "POST", path: "/v1/runs", body: {} }).catch((e: unknown) => e)) as ConnectionError;
    expect(err).toBeInstanceOf(ConnectionError);
    expect(err.message).toBe("api.test did not answer within 1000 ms");
  });
});

describe("Transport.fetch", () => {
  it("exposes the bare fetch for storage transfers", async () => {
    const { t, requests } = transport([new Response("ok")]);
    await t.fetch("https://storage.test/object?sig=secret", { method: "PUT" });
    expect(requests[0]!.headers.get("authorization")).toBeNull();
  });

  it("refuses a runtime without fetch", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => new Transport(CONFIG)).toThrow(/no global fetch/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
