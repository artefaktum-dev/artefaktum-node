/**
 * Readable names over the generated schema, and the SDK's option types.
 *
 * Responses ARE the generated types: snake_case fields, ISO-string timestamps, exactly what
 * the API sends. Option types are hand-written because `openapi-typescript` marks a request
 * field that has a server default as required, and because the SDK's options differ from
 * request bodies (`project` for `project_id`, `run` for `run_id`, a source for `size_bytes`).
 * `client.ts` types every request BODY against `Schemas[...]`, so a server-side rename is a
 * compile error here rather than a 400 at runtime.
 */
import type { components } from "./schema.gen.js";

export type Schemas = components["schemas"];

export type Artifact = Schemas["ArtifactView"];
export type Version = Schemas["VersionView"];
export type ArtifactRef = Schemas["ArtifactRef"];
export type UploadInstructions = Schemas["UploadInstructions"];
export type UploadTicket = Schemas["CreateUploadResponse"];
export type ArtifactPage = Schemas["ArtifactList"];
export type SearchHit = Schemas["SearchHit"];
export type SearchPage = Schemas["SearchResponse"];
export type Resolution = Schemas["ResolveResponse"];
export type Download = Schemas["DownloadView"];
export type Relation = Schemas["RelationView"];
export type Run = Schemas["RunView"];
export type Project = Schemas["ProjectView"];
export type ApiKey = Schemas["KeyView"];
export type CreatedKey = Schemas["CreatedKey"];
export type UsagePoint = Schemas["UsagePoint"];
export type Quota = Schemas["QuotaView"];
export type SearchMode = Schemas["SearchRequest"]["mode"];

/** `GET /health/whoami` is untyped in the OpenAPI document. */
export interface Identity {
  tenant_id: string;
  project_id: string | null;
}

/** A timestamp option: an ISO 8601 string, or a `Date` (sent as `toISOString()`). */
export type Timestamp = string | Date;

/** Bytes the SDK can upload on any runtime. */
export type ByteSource = Uint8Array | ArrayBuffer | Blob;
/** What `push` accepts: a file path (`string` or `file:` URL, Node only) or bytes. */
export type Source = string | URL | ByteSource;

export interface ProjectScoped {
  /** A project UUID or slug; overrides the client's default for this call. */
  project?: string;
}

export interface WaitOptions {
  /** Wait for the artifact to become `ready` (default `true`). */
  wait?: boolean;
  /** How long to wait, in milliseconds (default 30 000). */
  timeout_ms?: number;
  /** Cancels the storage transfer and the wait. */
  signal?: AbortSignal;
}

/** The descriptive fields of a new artifact. */
export interface UploadFields {
  title: string;
  description?: string;
  tags?: readonly string[];
  metadata?: Record<string, unknown>;
  external_key?: string;
  expires_at?: Timestamp;
  summary?: string;
  /** A run id; with `infer_lineage` the server links this artifact to what the run read. */
  run?: string;
  infer_lineage?: boolean;
}

export interface CreateUploadOptions extends UploadFields, ProjectScoped {
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface CompleteUploadOptions {
  sha256?: string;
  size_bytes?: number;
  etag?: string;
}

export interface PushOptions extends UploadFields, ProjectScoped, WaitOptions {
  /** Required when the source is bytes or a Blob without a name. */
  filename?: string;
  /** Default: the Blob's type, else guessed from the filename. */
  content_type?: string;
}

export interface CreateVersionOptions extends WaitOptions {
  summary?: string;
  run?: string;
  infer_lineage?: boolean;
  content_type?: string;
  filename?: string;
}

/** `fulfil` takes no name: the reservation already fixed it. */
export type FulfilOptions = WaitOptions;

export interface ListOptions extends ProjectScoped {
  status?: string | readonly string[];
  content_type?: string;
  tag?: string;
  external_key?: string;
  created_before?: Timestamp;
  created_after?: Timestamp;
  expires_before?: Timestamp;
  limit?: number;
  cursor?: string;
}

export type IterAllOptions = Omit<ListOptions, "cursor">;

export interface SearchOptions extends ProjectScoped {
  mode?: SearchMode;
  limit?: number;
  cursor?: string;
  content_types?: readonly string[];
  tags_all?: readonly string[];
  status?: string | readonly string[];
  external_key?: string;
  created_after?: Timestamp;
  created_before?: Timestamp;
  exclude_superseded?: boolean;
}

export interface ResolveOptions extends ProjectScoped {
  filename: string;
  content_type: string;
  size_bytes: number;
  title: string;
  description?: string;
  tags?: readonly string[];
  metadata?: Record<string, unknown>;
  /** A hit older than this many seconds counts as a miss. */
  max_age_seconds?: number;
  run?: string;
}

export interface DownloadUrlOptions {
  version_id?: string;
  run?: string;
}

export interface PullOptions {
  /** Compare the bytes with the version's sha256 (default `true`). */
  verify?: boolean;
  signal?: AbortSignal;
}

export interface PulledBytes {
  data: Uint8Array;
  filename: string;
  content_type: string;
  version_id: string;
  sha256: string | null;
}

export interface UpdateOptions {
  title?: string;
  description?: string;
  tags?: readonly string[];
  metadata?: Record<string, unknown>;
  expires_at?: Timestamp;
  /** Remove the expiry. Sent only when `true`. */
  clear_expires_at?: boolean;
}

export interface AddRelationOptions {
  to_version_id?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRunOptions extends ProjectScoped {
  run_id?: string;
}

export interface RunArtifactsOptions {
  limit?: number;
  cursor?: string;
}

export interface CreateKeyOptions extends ProjectScoped {
  expires_at?: Timestamp;
}

export interface UsageOptions extends ProjectScoped {
  start?: Timestamp;
  end?: Timestamp;
  granularity?: "hour" | "day";
  metric?: string;
  principal_id?: string;
}
