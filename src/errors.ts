/** The error family and the problem+json → error mapping (design spec §8). */
import type { Artifact } from "./types.js";

export const RELATION_TYPES = [
  "derived_from",
  "supersedes",
  "attachment_of",
  "generated_by",
  "related_to",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface ErrorDetails {
  code?: string;
  status?: number;
  request_id?: string;
  cause?: unknown;
}

/**
 * Any failure reported by the API or by the SDK's own multi-step helpers. Branch on
 * `code` where you can: `instanceof` fails across the ESM and CJS copies of this package
 * if both end up loaded.
 */
export class ArtefaktumError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  readonly request_id: string | undefined;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = new.target.name;
    this.code = details.code ?? "error";
    this.status = details.status;
    this.request_id = details.request_id;
  }

  override toString(): string {
    const tail = this.request_id ? ` (request_id=${this.request_id})` : "";
    return `${this.name}: ${this.code}: ${this.message}${tail}`;
  }
}

export class NotFoundError extends ArtefaktumError {}
export class UnauthorizedError extends ArtefaktumError {}
export class ForbiddenError extends ArtefaktumError {}
export class QuotaExceededError extends ArtefaktumError {}
export class ConflictError extends ArtefaktumError {}
export class ValidationError extends ArtefaktumError {}
export class UploadError extends ArtefaktumError {}
export class ServiceUnavailableError extends ArtefaktumError {}

/** The API host could not be reached, or did not answer in time, after any retries. */
export class ConnectionError extends ArtefaktumError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: "connection_error", cause });
  }
}

export class ProcessingFailedError extends ArtefaktumError {
  readonly artifact: Artifact;
  constructor(artifact: Artifact, message = "the server could not process the upload") {
    super(message, { code: "processing_failed" });
    this.artifact = artifact;
  }
}

export class ProcessingTimeoutError extends ArtefaktumError {
  readonly artifact: Artifact;
  constructor(artifact: Artifact, timeout_ms: number) {
    super(`artifact still ${artifact.status} after ${timeout_ms} ms`, { code: "processing_timeout" });
    this.artifact = artifact;
  }
}

export class IntegrityError extends ArtefaktumError {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`sha256 mismatch: expected ${expected}, got ${actual}`, { code: "integrity_error" });
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Object storage refused or could not be reached. Carries the HOST only: the signed URL's
 * query string is a credential and must never reach a message or a log.
 */
export class StorageError extends ArtefaktumError {
  readonly host: string;
  constructor(status: number | undefined, host: string, cause?: unknown) {
    super(
      status === undefined
        ? `could not reach object storage at ${host}`
        : `object storage at ${host} answered ${status}`,
      { code: "storage_error", status, cause },
    );
    this.host = host;
  }
}

/** No API key given and ARTEFAKTUM_API_KEY is not set. Thrown before any request. */
export class MissingApiKeyError extends Error {
  constructor(message = "pass apiKey or set ARTEFAKTUM_API_KEY") {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

type ErrorClass = new (message: string, details?: ErrorDetails) => ArtefaktumError;

const BY_CODE: Record<string, ErrorClass> = {
  artifact_not_found: NotFoundError,
  run_not_found: NotFoundError,
  // `api/errors.py` labels a 404 that carries no domain code of its own `not_found`.
  not_found: NotFoundError,
  unauthorized: UnauthorizedError,
  insufficient_scope: ForbiddenError,
  quota_exceeded: QuotaExceededError,
  artifact_not_ready: ConflictError,
  external_key_conflict: ConflictError,
  idempotency_conflict: ConflictError,
  run_sealed: ConflictError,
  invalid_request: ValidationError,
  upload_expired: UploadError,
  object_verification_failed: UploadError,
  embedding_unavailable: ServiceUnavailableError,
};

/** Turn an HTTP error response into the matching error (RFC 9457 body or not). */
export function fromProblem(status: number, body: unknown, statusText: string): ArtefaktumError {
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("code" in body)) {
    return new ArtefaktumError(`${status} ${statusText}`.trim(), { code: "http_error", status });
  }
  const problem = body as { code: unknown; detail?: unknown; title?: unknown; request_id?: unknown };
  const code = String(problem.code);
  const cls = BY_CODE[code] ?? ArtefaktumError;
  const message = String(problem.detail || problem.title || code);
  const request_id = typeof problem.request_id === "string" ? problem.request_id : undefined;
  return new cls(message, { code, status, request_id });
}
