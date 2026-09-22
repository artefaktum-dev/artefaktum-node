import { describe, expect, it } from "vitest";
import {
  ArtefaktumError,
  ConflictError,
  ConnectionError,
  ForbiddenError,
  IntegrityError,
  MissingApiKeyError,
  NotFoundError,
  ProcessingFailedError,
  ProcessingTimeoutError,
  QuotaExceededError,
  RELATION_TYPES,
  ServiceUnavailableError,
  StorageError,
  UnauthorizedError,
  UploadError,
  ValidationError,
  fromProblem,
} from "../src/errors.js";
import type { Artifact } from "../src/types.js";

const CODES: Array<[string, new (...args: never[]) => ArtefaktumError]> = [
  ["artifact_not_found", NotFoundError],
  ["run_not_found", NotFoundError],
  ["not_found", NotFoundError],
  ["unauthorized", UnauthorizedError],
  ["insufficient_scope", ForbiddenError],
  ["quota_exceeded", QuotaExceededError],
  ["artifact_not_ready", ConflictError],
  ["external_key_conflict", ConflictError],
  ["idempotency_conflict", ConflictError],
  ["run_sealed", ConflictError],
  ["invalid_request", ValidationError],
  ["upload_expired", UploadError],
  ["object_verification_failed", UploadError],
  ["embedding_unavailable", ServiceUnavailableError],
];

describe("fromProblem", () => {
  it.each(CODES)("maps %s to its subclass", (code, cls) => {
    const err = fromProblem(418, { code, detail: "why", request_id: "req_1" }, "I'm a teapot");
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(ArtefaktumError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.message).toBe("why");
    expect(err.status).toBe(418);
    expect(err.request_id).toBe("req_1");
    expect(err.name).toBe(cls.name);
  });

  it("keeps an unknown code on the base class", () => {
    const err = fromProblem(500, { code: "brand_new", title: "New" }, "Server Error");
    expect(err.constructor).toBe(ArtefaktumError);
    expect(err.code).toBe("brand_new");
    expect(err.message).toBe("New");
  });

  it("falls back to the code when there is no detail or title", () => {
    expect(fromProblem(409, { code: "run_sealed" }, "Conflict").message).toBe("run_sealed");
  });

  it.each([["<html>bad gateway</html>"], [null], [["x"]], [{ detail: "no code here" }]])(
    "treats a body without a code (%j) as http_error",
    (body) => {
      const err = fromProblem(502, body, "Bad Gateway");
      expect(err.code).toBe("http_error");
      expect(err.message).toBe("502 Bad Gateway");
      expect(err.status).toBe(502);
    },
  );
});

describe("ArtefaktumError", () => {
  it("renders name, code, message and the request id", () => {
    const err = new NotFoundError("no such artifact", { code: "artifact_not_found", request_id: "req_9" });
    expect(String(err)).toBe("NotFoundError: artifact_not_found: no such artifact (request_id=req_9)");
  });

  it("omits the request id when there is none", () => {
    expect(String(new ArtefaktumError("boom"))).toBe("ArtefaktumError: error: boom");
  });

  it("preserves a cause", () => {
    const cause = new TypeError("fetch failed");
    expect(new ConnectionError("could not reach api.example", cause).cause).toBe(cause);
  });
});

describe("helper errors", () => {
  const artifact = { id: "a1", status: "processing" } as Artifact;

  it("ProcessingFailedError carries the artifact", () => {
    const err = new ProcessingFailedError(artifact);
    expect(err.code).toBe("processing_failed");
    expect(err.artifact).toBe(artifact);
  });

  it("ProcessingTimeoutError names the status and the wait", () => {
    const err = new ProcessingTimeoutError(artifact, 30_000);
    expect(err.code).toBe("processing_timeout");
    expect(err.message).toBe("artifact still processing after 30000 ms");
    expect(err.artifact).toBe(artifact);
  });

  it("IntegrityError keeps both digests", () => {
    const err = new IntegrityError("aaa", "bbb");
    expect(err.code).toBe("integrity_error");
    expect(err.message).toBe("sha256 mismatch: expected aaa, got bbb");
    expect([err.expected, err.actual]).toEqual(["aaa", "bbb"]);
  });

  it("StorageError names the host and the status, never a URL", () => {
    const err = new StorageError(403, "bucket.r2.example");
    expect(err.code).toBe("storage_error");
    expect(err.status).toBe(403);
    expect(err.host).toBe("bucket.r2.example");
    expect(err.message).toBe("object storage at bucket.r2.example answered 403");
  });

  it("StorageError without a status is a connection failure", () => {
    expect(new StorageError(undefined, "h.example").message).toBe("could not reach object storage at h.example");
  });

  it("ConnectionError has its code", () => {
    expect(new ConnectionError("x").code).toBe("connection_error");
  });

  it("MissingApiKeyError is not an ArtefaktumError", () => {
    const err = new MissingApiKeyError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ArtefaktumError);
    expect(err.name).toBe("MissingApiKeyError");
    expect(err.message).toBe("pass apiKey or set ARTEFAKTUM_API_KEY");
  });

  it("lists the server's relation types", () => {
    expect([...RELATION_TYPES].sort()).toEqual(
      ["attachment_of", "derived_from", "generated_by", "related_to", "supersedes"],
    );
  });
});
