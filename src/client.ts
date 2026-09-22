/**
 * The client and its namespaces (design spec §5). Every method returns a Promise; request
 * bodies are typed against the generated schema so a server-side change is a compile error.
 */
import { type ClientOptions, isUuid, loadConfig } from "./config.js";
import { NotFoundError, RELATION_TYPES, type RelationType } from "./errors.js";
import { type Prepared, fetchBytes, loadNode, prepare, pullPlan, putToStorage, signedVersion, waitReady } from "./files.js";
import { type Sleep, Transport } from "./transport.js";
import type {
  AddRelationOptions, ApiKey, Artifact, ArtifactPage, ArtifactRef, CompleteUploadOptions, CreateKeyOptions, CreateRunOptions,
  CreateUploadOptions, CreateVersionOptions, CreatedKey, Download, DownloadUrlOptions, FulfilOptions, Identity, IterAllOptions,
  ListOptions, Project, PullOptions, PulledBytes, PushOptions, Quota, Relation, ResolveOptions, Resolution, Run, RunArtifactsOptions,
  Schemas, SearchOptions, SearchPage, Source, Timestamp, UpdateOptions, UploadTicket, UsageOptions, UsagePoint, Version, WaitOptions,
} from "./types.js";

/** What the namespaces share. Not exported from the package. */
export interface Core {
  transport: Transport;
  /** A project UUID: the override, else the cached default. */
  projectId(override?: string): Promise<string>;
  /** Test seam for the wait loop; `undefined` means real time. */
  sleep: Sleep | undefined;
}

const seg = encodeURIComponent;

function iso(value: Timestamp | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * A filter that may be one string, a list, or nothing. An empty list becomes `undefined` so
 * the key is dropped and the server applies its own default, rather than "match nothing".
 */
function strings(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = typeof value === "string" ? [value] : [...value];
  return items.length > 0 ? items : undefined;
}

function findProject(slug: string, projects: readonly Project[]): string {
  const found = projects.find((p) => p.slug === slug);
  if (found) return found.id;
  const available = projects.map((p) => p.slug).sort();
  throw new NotFoundError(`no project with slug ${JSON.stringify(slug)}; available: ${JSON.stringify(available)}`, {
    code: "project_not_found",
  });
}

export class Projects {
  constructor(private readonly core: Core) {}

  async list(): Promise<Project[]> {
    return (await this.core.transport.request<Schemas["ProjectList"]>({ method: "GET", path: "/v1/projects" })).items;
  }
}

export class Artifacts {
  constructor(private readonly core: Core) {}

  // -- the three upload steps ------------------------------------------------------------

  async createUpload(opts: CreateUploadOptions): Promise<UploadTicket> {
    const body: Schemas["CreateUploadRequest"] = {
      project_id: await this.core.projectId(opts.project),
      filename: opts.filename,
      content_type: opts.content_type,
      size_bytes: opts.size_bytes,
      title: opts.title,
      description: opts.description ?? "",
      tags: [...(opts.tags ?? [])],
      metadata: opts.metadata ?? {},
      external_key: opts.external_key,
      expires_at: iso(opts.expires_at),
      summary: opts.summary,
      run_id: opts.run,
      infer_lineage: opts.infer_lineage ?? true,
    };
    return this.core.transport.request({ method: "POST", path: "/v1/artifacts/uploads", body });
  }

  async completeUpload(artifact_id: string, version_id: string, opts: CompleteUploadOptions = {}): Promise<ArtifactRef> {
    const body: Schemas["CompleteUploadRequest"] = { sha256: opts.sha256, size_bytes: opts.size_bytes, etag: opts.etag };
    return this.core.transport.request({
      method: "POST",
      path: `/v1/artifacts/${seg(artifact_id)}/versions/${seg(version_id)}/complete`,
      body,
    });
  }

  /**
   * PUT the bytes, complete the version, then read the artifact back (design spec §7, steps
   * 3-5). See `push`'s doc comment for the three ways this can fail partway and what each
   * one leaves behind.
   */
  private async upload(ticket: UploadTicket, prepared: Prepared, opts: WaitOptions): Promise<Artifact> {
    await putToStorage(this.core.transport.fetch, ticket.upload, prepared, opts.signal);
    await this.completeUpload(ticket.artifact.id, ticket.artifact.version_id, {
      sha256: prepared.sha256,
      size_bytes: prepared.size,
    });
    const get = () => this.get(ticket.artifact.id);
    if (opts.wait === false) return get();
    return waitReady(get, { timeout_ms: opts.timeout_ms ?? 30_000, signal: opts.signal, sleep: this.core.sleep });
  }

  /**
   * Hash, reserve, upload, complete and (by default) wait for `ready`.
   *
   * `source` is a file path (Node only; streamed, never held whole) or bytes / a Blob, which
   * need `filename` unless the Blob is a named `File`. The bytes go straight to object
   * storage with no Authorization header, so the API key never reaches that host.
   *
   * Failure modes, in the order they can happen: `createUpload` failing leaves nothing
   * behind. A failing PUT throws `StorageError` and leaves the new artifact (or version)
   * `pending_upload` server-side -- never `ready`, invisible to `search` -- safe to abandon
   * or retry with a fresh ticket. `completeUpload` failing is NOT retried and leaves the
   * same state, with the bytes already sitting in storage.
   *
   * `wait: true` polls every 0.5 s and throws `ProcessingFailedError` or
   * `ProcessingTimeoutError`; `wait: false` returns after a single `get`.
   */
  async push(source: Source, opts: PushOptions): Promise<Artifact> {
    const { wait, timeout_ms, signal, filename, content_type, ...fields } = opts;
    const prepared = await prepare(source, { filename, content_type });
    const ticket = await this.createUpload({
      ...fields,
      filename: prepared.filename,
      content_type: prepared.content_type,
      size_bytes: prepared.size,
    });
    return this.upload(ticket, prepared, { wait, timeout_ms, signal });
  }

  /** A new version of an existing artifact: `push`'s flow over `POST /{id}/uploads`. */
  async createVersion(artifact_id: string, source: Source, opts: CreateVersionOptions = {}): Promise<Artifact> {
    const prepared = await prepare(source, { filename: opts.filename, content_type: opts.content_type });
    const body: Schemas["CreateVersionRequest"] = {
      filename: prepared.filename,
      content_type: prepared.content_type,
      size_bytes: prepared.size,
      summary: opts.summary,
      run_id: opts.run,
      infer_lineage: opts.infer_lineage ?? true,
    };
    const ticket = await this.core.transport.request<UploadTicket>({
      method: "POST",
      path: `/v1/artifacts/${seg(artifact_id)}/uploads`,
      body,
    });
    return this.upload(ticket, prepared, opts);
  }

  /** Upload the bytes a `resolve` asked for. Throws `TypeError` unless the status is `create`. */
  async fulfil(resolution: Resolution, source: Source, opts: FulfilOptions = {}): Promise<Artifact> {
    if (resolution.status !== "create" || !resolution.reservation || !resolution.upload) {
      throw new TypeError(
        `fulfil expects a resolution with status "create" carrying a reservation and an upload; got status ${JSON.stringify(resolution.status)}`,
      );
    }
    // The reservation already fixed the stored name and the signed PUT carries its own
    // content type, so the name here only satisfies `prepare` for nameless bytes.
    const prepared = await prepare(source, { filename: "reserved" });
    return this.upload({ artifact: resolution.reservation, upload: resolution.upload }, prepared, opts);
  }

  // -- reads -----------------------------------------------------------------------------

  async get(artifact_id: string): Promise<Artifact> {
    return this.core.transport.request({ method: "GET", path: `/v1/artifacts/${seg(artifact_id)}` });
  }

  /** `key` is a path segment that may contain `/`; it is percent-encoded whole. */
  async getByExternalKey(key: string, opts: { project?: string } = {}): Promise<Artifact> {
    return this.core.transport.request({
      method: "GET",
      path: `/v1/artifacts/by-external-key/${seg(key)}`,
      query: { project_id: await this.core.projectId(opts.project) },
    });
  }

  async list(opts: ListOptions = {}): Promise<ArtifactPage> {
    return this.listPage(await this.core.projectId(opts.project), opts, opts.cursor);
  }

  /** Every artifact matching the filters, following `next_cursor`. The project is resolved once. */
  async *iterAll(opts: IterAllOptions = {}): AsyncGenerator<Artifact, void, undefined> {
    const project_id = await this.core.projectId(opts.project);
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listPage(project_id, opts, cursor);
      yield* page.items;
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  private listPage(project_id: string, opts: IterAllOptions, cursor: string | undefined): Promise<ArtifactPage> {
    return this.core.transport.request({
      method: "GET",
      path: "/v1/artifacts",
      query: {
        project_id,
        status: strings(opts.status),
        content_type: opts.content_type,
        tag: opts.tag,
        external_key: opts.external_key,
        created_before: iso(opts.created_before),
        created_after: iso(opts.created_after),
        expires_before: iso(opts.expires_before),
        limit: opts.limit ?? 50,
        cursor,
      },
    });
  }

  async search(query = "", opts: SearchOptions = {}): Promise<SearchPage> {
    const filters: Partial<Schemas["SearchFilters"]> = {
      content_types: strings(opts.content_types),
      tags_all: strings(opts.tags_all),
      status: strings(opts.status),
      external_key: opts.external_key,
      created_after: iso(opts.created_after),
      created_before: iso(opts.created_before),
      exclude_superseded: opts.exclude_superseded,
    };
    const body: Omit<Schemas["SearchRequest"], "filters"> & { filters?: Partial<Schemas["SearchFilters"]> } = {
      project_id: await this.core.projectId(opts.project),
      query,
      mode: opts.mode ?? "hybrid",
      limit: opts.limit ?? 20,
      cursor: opts.cursor,
      filters: Object.values(filters).some((v) => v !== undefined) ? filters : undefined,
    };
    // POST only because the filter body does not fit a query string; it has no side
    // effects, so it is retried like any other read.
    return this.core.transport.request({ method: "POST", path: "/v1/artifacts/search", body, idempotent: true });
  }

  async resolve(external_key: string, opts: ResolveOptions): Promise<Resolution> {
    const body: Schemas["ResolveRequest"] = {
      project_id: await this.core.projectId(opts.project),
      external_key,
      max_age_seconds: opts.max_age_seconds,
      filename: opts.filename,
      content_type: opts.content_type,
      size_bytes: opts.size_bytes,
      title: opts.title,
      description: opts.description ?? "",
      tags: [...(opts.tags ?? [])],
      metadata: opts.metadata ?? {},
      run_id: opts.run,
    };
    return this.core.transport.request({ method: "POST", path: "/v1/artifacts/resolve", body });
  }

  async downloadUrl(artifact_id: string, opts: DownloadUrlOptions = {}): Promise<Download> {
    return this.core.transport.request({
      method: "GET",
      path: `/v1/artifacts/${seg(artifact_id)}/download`,
      query: { version_id: opts.version_id, run_id: opts.run },
    });
  }

  /** The signed download plus the version whose name and digest belong to those bytes. */
  private async planPull(artifact_id: string, verify: boolean) {
    const download = await this.downloadUrl(artifact_id);
    let version = signedVersion(await this.versions(artifact_id), download);
    if (version === undefined) {
      const latest = (await this.get(artifact_id)).latest_version;
      version = signedVersion(latest ? [latest] : [], download);
    }
    return { download, ...pullPlan(version, download, verify) };
  }

  /**
   * Stream the bytes to `dest` (Node only), checking the digest, and return the final path.
   * `dest` is a directory when it exists as one or ends with a path separator (then it is
   * created) -- the file is named after the signed version, reduced to a basename --
   * otherwise it is the file to write. A digest mismatch leaves no file behind and throws
   * `IntegrityError`; `verify: false` skips the comparison.
   */
  async pull(artifact_id: string, dest: string, opts: PullOptions = {}): Promise<string> {
    const { download, version, expected_sha256 } = await this.planPull(artifact_id, opts.verify ?? true);
    const node = await loadNode();
    return node.downloadToPath(this.core.transport.fetch, download.url, dest, {
      filename: version.original_filename,
      expected_sha256,
      signal: opts.signal,
    });
  }

  /**
   * The verified bytes in memory; works on every runtime. `filename` is as uploaded --
   * reduce it to a basename before using it as a path (`pull` does).
   */
  async pullBytes(artifact_id: string, opts: PullOptions = {}): Promise<PulledBytes> {
    const { download, version, expected_sha256 } = await this.planPull(artifact_id, opts.verify ?? true);
    const data = await fetchBytes(this.core.transport.fetch, download.url, expected_sha256, opts.signal);
    return {
      data,
      filename: version.original_filename,
      content_type: version.content_type,
      version_id: version.id,
      sha256: version.sha256,
    };
  }

  // -- metadata and graph ----------------------------------------------------------------

  /** Only the fields given are sent; `clear_expires_at` only when `true`. */
  async update(artifact_id: string, opts: UpdateOptions): Promise<Artifact> {
    const body: Partial<Schemas["UpdateMetadataRequest"]> = {
      title: opts.title,
      description: opts.description,
      tags: opts.tags === undefined ? undefined : [...opts.tags],
      metadata: opts.metadata,
      expires_at: iso(opts.expires_at),
    };
    if (opts.clear_expires_at) body.clear_expires_at = true;
    return this.core.transport.request({ method: "PATCH", path: `/v1/artifacts/${seg(artifact_id)}`, body });
  }

  async addRelation(
    artifact_id: string,
    to_artifact_id: string,
    relation_type: RelationType,
    opts: AddRelationOptions = {},
  ): Promise<Relation> {
    // JavaScript callers have no compiler to stop a typo before it costs a round trip.
    if (!RELATION_TYPES.includes(relation_type)) {
      throw new TypeError(`relation_type must be one of ${RELATION_TYPES.join(", ")}; got ${JSON.stringify(relation_type)}`);
    }
    const body: Schemas["CreateRelationRequest"] = {
      to_artifact_id,
      relation_type,
      to_version_id: opts.to_version_id,
      metadata: opts.metadata,
    };
    return this.core.transport.request({ method: "POST", path: `/v1/artifacts/${seg(artifact_id)}/relations`, body });
  }

  async relations(artifact_id: string): Promise<Relation[]> {
    return this.core.transport.request({ method: "GET", path: `/v1/artifacts/${seg(artifact_id)}/relations` });
  }

  async versions(artifact_id: string): Promise<Version[]> {
    return this.core.transport.request({ method: "GET", path: `/v1/artifacts/${seg(artifact_id)}/versions` });
  }

  /** Accepted with 202; the bytes are removed by a background job. */
  async delete(artifact_id: string): Promise<void> {
    await this.core.transport.request({ method: "DELETE", path: `/v1/artifacts/${seg(artifact_id)}` });
  }
}

export class Runs {
  constructor(private readonly core: Core) {}

  async create(opts: CreateRunOptions = {}): Promise<Run> {
    const body: Schemas["CreateRunRequest"] = { project_id: await this.core.projectId(opts.project), run_id: opts.run_id };
    return this.core.transport.request({ method: "POST", path: "/v1/runs", body });
  }

  async seal(run_id: string): Promise<Run> {
    return this.core.transport.request({ method: "POST", path: `/v1/runs/${seg(run_id)}/seal` });
  }

  async artifacts(run_id: string, opts: RunArtifactsOptions = {}): Promise<ArtifactPage> {
    return this.core.transport.request({
      method: "GET",
      path: `/v1/runs/${seg(run_id)}/artifacts`,
      query: { limit: opts.limit ?? 50, cursor: opts.cursor },
    });
  }
}

export class Keys {
  constructor(private readonly core: Core) {}

  /** No `project` mints a tenant-wide key, so the client's default project is NOT applied. */
  async create(name: string, scopes: readonly string[], opts: CreateKeyOptions = {}): Promise<CreatedKey> {
    const body: Schemas["CreateKeyRequest"] = {
      name,
      scopes: [...scopes],
      project_id: opts.project === undefined ? undefined : await this.core.projectId(opts.project),
      expires_at: iso(opts.expires_at),
    };
    return this.core.transport.request({ method: "POST", path: "/v1/api-keys", body });
  }

  async list(): Promise<ApiKey[]> {
    return this.core.transport.request({ method: "GET", path: "/v1/api-keys" });
  }

  async revoke(key_id: string): Promise<ApiKey> {
    return this.core.transport.request({ method: "DELETE", path: `/v1/api-keys/${seg(key_id)}` });
  }
}

export class Usage {
  constructor(private readonly core: Core) {}

  /** As for `keys.create`: no `project` means the whole tenant, not the default project. */
  async get(opts: UsageOptions = {}): Promise<UsagePoint[]> {
    const series = await this.core.transport.request<Schemas["UsageSeries"]>({
      method: "GET",
      path: "/v1/usage",
      query: {
        start: iso(opts.start),
        end: iso(opts.end),
        granularity: opts.granularity ?? "day",
        metric: opts.metric,
        project_id: opts.project === undefined ? undefined : await this.core.projectId(opts.project),
        principal_id: opts.principal_id,
      },
    });
    return series.items;
  }
}

export class Artefaktum {
  readonly projects: Projects;
  readonly artifacts: Artifacts;
  readonly runs: Runs;
  readonly keys: Keys;
  readonly usage: Usage;
  private readonly transport: Transport;
  private readonly defaultProject: string;
  private defaultProjectId: Promise<string> | undefined;

  /** @param internals test seams; not part of the public contract. */
  constructor(options: ClientOptions = {}, internals: { sleep?: Sleep } = {}) {
    const config = loadConfig(options);
    this.transport = new Transport(config, options.fetch, internals.sleep);
    this.defaultProject = config.project;
    const core: Core = {
      transport: this.transport,
      projectId: (override) => this.projectId(override),
      sleep: internals.sleep,
    };
    this.projects = new Projects(core);
    this.artifacts = new Artifacts(core);
    this.runs = new Runs(core);
    this.keys = new Keys(core);
    this.usage = new Usage(core);
  }

  /**
   * A UUID is used as given. A slug is looked up through `GET /v1/projects`: the client
   * default once -- the PROMISE is cached, so concurrent first calls share one lookup, and
   * a failed lookup is forgotten -- a per-call override every time.
   */
  private async projectId(override?: string): Promise<string> {
    if (override !== undefined) {
      return isUuid(override) ? override : findProject(override, await this.projects.list());
    }
    if (this.defaultProjectId === undefined) {
      const slug = this.defaultProject;
      const lookup = isUuid(slug) ? Promise.resolve(slug) : this.projects.list().then((all) => findProject(slug, all));
      this.defaultProjectId = lookup;
      lookup.catch(() => {
        if (this.defaultProjectId === lookup) this.defaultProjectId = undefined;
      });
    }
    return this.defaultProjectId;
  }

  async whoami(): Promise<Identity> {
    return this.transport.request({ method: "GET", path: "/health/whoami" });
  }

  /** Plan, limits and current usage. Never blocked by the call limit. */
  async quota(): Promise<Quota> {
    return this.transport.request({ method: "GET", path: "/v1/quota" });
  }
}
