# artefaktum

TypeScript/JavaScript client for [Artefaktum](https://artefaktum.dev): store, find and
trust the artifacts that AI agents hand to each other.

Zero dependencies. Node 20+. ESM and CommonJS. Typed from the API's OpenAPI document.

## Install

```bash
npm install artefaktum
```

## Quick start

Create an API key in the [console](https://artefaktum.dev/console/) and export it as
`ARTEFAKTUM_API_KEY`.

```ts
import { Artefaktum } from "artefaktum";

const client = new Artefaktum();

const artifact = await client.artifacts.push("report.pdf", {
  title: "Q3 churn analysis",
  tags: ["churn", "q3"],
  external_key: "reports/q3-churn",
});

const page = await client.artifacts.search("q3 churn");
for (const hit of page.items) console.log(hit.score, hit.artifact.title);

await client.artifacts.pull(artifact.id, "out/"); // out/report.pdf, sha256-verified
```

CommonJS: `const { Artefaktum } = require("artefaktum");`

## Configuration

| Option | Environment variable | Default |
|---|---|---|
| `apiKey` | `ARTEFAKTUM_API_KEY` | required |
| `baseUrl` | `ARTEFAKTUM_BASE_URL` | `https://api.artefaktum.dev` |
| `project` | `ARTEFAKTUM_PROJECT` | `default` |
| `timeoutMs` | — | `30000` per API call; storage transfers have none |
| `fetch` | — | `globalThis.fetch` |

`project` is a slug or a UUID. Project-scoped methods take `project` in their options to
override the default for one call.

Methods are camelCase; option and response fields are snake_case, spelled exactly as the
REST API spells them (`external_key`, `latest_version.size_bytes`, `stale_upstream`).
Timestamps are ISO 8601 strings; options accept a string or a `Date`.

## Uploading

```ts
await client.artifacts.push("data/export.parquet", { title: "Export" });          // a path (Node), streamed
await client.artifacts.push(bytes, { title: "Export", filename: "export.json" }); // Uint8Array | ArrayBuffer | Blob
await client.artifacts.createVersion(artifact.id, "data/export-v2.parquet");
```

`push` hashes the source, uploads it straight to object storage (the API key is never sent
there) and waits until the artifact is `ready`. `wait: false` returns as soon as the upload
is accepted; `signal` cancels. Storage transfers have no timeout of their own — pass
`signal: AbortSignal.timeout(ms)` to bound a large upload.

### Compute once, reuse everywhere

```ts
const r = await client.artifacts.resolve("openweather/vilnius/2026-09-21", {
  filename: "weather.json", content_type: "application/json", size_bytes: body.byteLength,
  title: "Vilnius weather", max_age_seconds: 3600,
});
if (r.status === "hit" && r.artifact) use(r.artifact);
else if (r.status === "create") await client.artifacts.fulfil(r, body);
else await sleep((r.retry_after_seconds ?? 2) * 1000); // "pending": another producer is already making it
```

## Downloading

```ts
const path = await client.artifacts.pull(id, "out/");            // Node: streams to disk, verifies sha256
const { data, filename } = await client.artifacts.pullBytes(id); // any runtime: verified bytes in memory
```

## Finding

```ts
await client.artifacts.search("emission factors", { mode: "hybrid", tags_all: ["ghg"] });
await client.artifacts.getByExternalKey("reports/q3-churn");
for await (const a of client.artifacts.iterAll({ tag: "churn" })) console.log(a.title);
```

Search hides superseded artifacts by default; each hit says whether it is `superseded` or
`stale_upstream`.

## Everything else

`client.artifacts`: `get`, `list`, `update`, `delete`, `versions`, `relations`,
`addRelation`, `downloadUrl`, `createUpload`, `completeUpload`. `client.runs`: `create`,
`seal`, `artifacts`. `client.projects.list()`. `client.keys` and `client.usage` (admin
scope). `client.whoami()`, `client.quota()`.

## Errors

Every failure is an `ArtefaktumError` with `code`, `message`, `status` and `request_id`
(quote it when contacting support). Subclasses: `NotFoundError`, `UnauthorizedError`,
`ForbiddenError`, `QuotaExceededError`, `ConflictError`, `ValidationError`, `UploadError`,
`ServiceUnavailableError`, `ConnectionError`, `StorageError`, `ProcessingFailedError`,
`ProcessingTimeoutError`, `IntegrityError`. `MissingApiKeyError` (no key at all) extends
`Error`; a caller mistake such as `fulfil` on a non-`create` resolution throws `TypeError`.

```ts
try {
  await client.artifacts.get(id);
} catch (err) {
  if (err instanceof ArtefaktumError && err.code === "artifact_not_found") { /* … */ }
  else throw err;
}
```

Prefer `err.code` to `instanceof` in libraries: if a program loads both the ESM and the
CommonJS build, their classes are distinct.

`QuotaExceededError` means a plan limit is reached: 413 for storage or file size, 429 for
the month's API calls. `client.quota()` reports the plan, its limits and current usage.

Reads are retried up to twice on 429, 502, 503, 504 and network failures, honouring
`Retry-After`. Writes and storage transfers are never retried.

## Runtimes

Tested on Node 20 and 22. The core uses only `fetch` and Web Crypto, so it also runs on
Bun, Deno and Cloudflare Workers; there, pass bytes or a Blob to `push` and use
`pullBytes` — file paths need Node. Browsers are not supported: an API key does not belong
in a browser.

## Issues and contributions

Open an issue for bugs and questions. Pull requests are welcome; they are applied upstream
and land here with the next release rather than being merged directly.

## License

MIT
