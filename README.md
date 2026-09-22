# artefaktum

TypeScript/JavaScript client for [Artefaktum](https://artefaktum.dev) — store and find the
artifacts that agents hand to each other: files plus the metadata needed to find them and to
judge whether they are still current.

Zero dependencies. Node 20+. ESM and CommonJS. Typed from the API's own OpenAPI document.

```bash
npm install artefaktum
```

## Quick start

```ts
import { Artefaktum } from "artefaktum";

const client = new Artefaktum(); // reads ARTEFAKTUM_API_KEY; project "default"

const artifact = await client.artifacts.push("report.pdf", {
  title: "Q3 churn analysis",
  tags: ["churn", "q3"],
  external_key: "reports/q3-churn",
});

const page = await client.artifacts.search("q3 churn");
for (const hit of page.items) console.log(hit.score, hit.artifact.title);

await client.artifacts.pull(artifact.id, "out/"); // → out/report.pdf, sha256-verified
```

CommonJS works the same way: `const { Artefaktum } = require("artefaktum");`

Create an API key in the [console](https://artefaktum.dev/console).

## Configuration

| Option | Environment | Default |
|---|---|---|
| `apiKey` | `ARTEFAKTUM_API_KEY` | — (required; `MissingApiKeyError` otherwise) |
| `baseUrl` | `ARTEFAKTUM_BASE_URL` | `https://api.artefaktum.dev` |
| `project` | `ARTEFAKTUM_PROJECT` | `"default"` |
| `timeoutMs` | — | `30000`, per API call; storage transfers have none |
| `fetch` | — | `globalThis.fetch` |

`project` is a UUID or a slug. A slug is looked up once and cached. Every project-scoped
method also takes `project` in its options to override the default for one call.

## Conventions

- **Methods are camelCase, data is snake_case.** Option fields and response fields are
  spelled exactly as the REST API, the MCP tools and the Python SDK spell them
  (`external_key`, `latest_version.size_bytes`, `stale_upstream`).
- Timestamps in responses are ISO 8601 strings. Options accept a string or a `Date`.
- Durations name their unit: `timeoutMs`, `timeout_ms`, `max_age_seconds`.

## Uploading

```ts
await client.artifacts.push("data/export.parquet", { title: "Export" });          // a path (Node): streamed
await client.artifacts.push(bytes, { title: "Export", filename: "export.json" }); // Uint8Array | ArrayBuffer | Blob
```

`push` hashes the source, reserves an upload, PUTs the bytes **directly to object storage**
(your API key is never sent there), completes the upload, and waits until the artifact is
`ready`. Pass `wait: false` to return immediately, `timeout_ms` to wait longer than 30 s,
`signal` to cancel. A path is never loaded into memory; bytes and Blobs are.

Storage transfers deliberately have **no timeout of their own** — a total timeout would kill
a large upload, and `fetch` offers no inactivity timeout. Pass `signal` if you need a bound,
e.g. `AbortSignal.timeout(10 * 60_000)`.

`createVersion(artifact_id, source)` adds a version to an existing artifact.

### Compute once, reuse everywhere

```ts
const r = await client.artifacts.resolve("openweather/vilnius/2026-09-21", {
  filename: "weather.json", content_type: "application/json", size_bytes: body.byteLength,
  title: "Vilnius weather", max_age_seconds: 3600,
});
if (r.status === "hit" && r.artifact) use(r.artifact);
else if (r.status === "create") await client.artifacts.fulfil(r, body);
else await sleep((r.retry_after_seconds ?? 2) * 1000); // "pending": someone else is producing it
```

## Downloading

```ts
const path = await client.artifacts.pull(id, "out/");     // Node: streams to disk, verifies sha256, atomic rename
const { data, filename } = await client.artifacts.pullBytes(id); // any runtime: verified bytes in memory
```

## Finding

```ts
await client.artifacts.search("emission factors", { mode: "hybrid", tags_all: ["ghg"] });
await client.artifacts.getByExternalKey("reports/q3-churn");
for await (const a of client.artifacts.iterAll({ tag: "churn" })) console.log(a.title);
```

Search hides superseded artifacts by default; each result says whether it is `superseded`
or `stale_upstream`.

## Everything else

`client.artifacts`: `get`, `list`, `update`, `delete`, `versions`, `relations`,
`addRelation`, `downloadUrl`, `createUpload`, `completeUpload`. `client.runs`: `create`,
`seal`, `artifacts`. `client.projects.list()`. `client.keys` and `client.usage` (admin
scope). `client.whoami()`, `client.quota()`.

## Errors

Every failure reported by the API, by object storage, or by the SDK's own multi-step helpers
is an `ArtefaktumError` with `code`, `message`, `status` and `request_id` (quote it in
support mail). Two things are not: `MissingApiKeyError` (no key at all) extends `Error`, and
a caller mistake the compiler can't catch in plain JavaScript — `fulfil` on a non-`create`
resolution, an unknown `relation_type`, nameless bytes without `filename`, an invalid
`baseUrl` — throws `TypeError`.

| Class | `code` |
|---|---|
| `NotFoundError` | `artifact_not_found`, `run_not_found`, `not_found`, `project_not_found` |
| `UnauthorizedError` / `ForbiddenError` | `unauthorized` / `insufficient_scope` |
| `QuotaExceededError` | `quota_exceeded` |
| `ConflictError` | `artifact_not_ready`, `external_key_conflict`, `idempotency_conflict`, `run_sealed` |
| `ValidationError` | `invalid_request` |
| `UploadError` | `upload_expired`, `object_verification_failed` |
| `ServiceUnavailableError` | `embedding_unavailable` |
| `ConnectionError` | `connection_error` — the API could not be reached, after retries |
| `StorageError` | `storage_error` — object storage refused or could not be reached |
| `ProcessingFailedError` / `ProcessingTimeoutError` | `processing_failed` / `processing_timeout` (both carry `.artifact`) |
| `IntegrityError` | `integrity_error` — downloaded bytes do not match the recorded sha256 |
| `ArtefaktumError` | `version_mismatch` — the artifact gained a version between signing the download and reading its metadata; retry the pull |
| `ArtefaktumError` | `invalid_filename` — the server's filename is not usable as a file name |
| `ArtefaktumError` | `unsupported_runtime` — a file path was passed on a runtime without Node's `fs` |
| `ArtefaktumError` | `http_error` — a non-JSON response, e.g. from a proxy |

```ts
try {
  await client.artifacts.get(id);
} catch (err) {
  if (err instanceof ArtefaktumError && err.code === "artifact_not_found") { /* … */ }
  else throw err;
}
```

Prefer `err.code` to `instanceof` in libraries: if a program loads both the ESM and the
CommonJS build of this package, their classes are distinct.

Reads (every `GET`, and `search`) are retried up to twice on 429/502/503/504 and on network
failures, honouring `Retry-After` up to a ceiling of 10 s. Writes and storage transfers are
never retried. A spent
quota is never retried.

## Runtimes

Tested on Node 20 and 22. The core uses only `fetch` and Web Crypto, so it should also run
on Bun, Deno and Cloudflare Workers; there, pass bytes or a Blob to `push` and use
`pullBytes` — file paths need Node. Browsers are not supported: an API key does not belong
in a browser.

## Issues and contributions

Bug reports and questions belong in this repository's issue tracker. The code here is
mirrored out of a private monorepo it shares with the server, so a pull request cannot be
merged directly -- it will be applied upstream and land here in the next release, with the
author credited. Small fixes are welcome that way.

## License

MIT
