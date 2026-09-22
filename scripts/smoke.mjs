// Builds nothing: run `npm run build` first. Packs the package, installs the TARBALL into a
// temp project, and proves from both module systems that what we ship works: the exports are
// there, errors keep their names, and a `push` from a file path runs end to end against a
// local fake API -- which exercises the lazily loaded Node chunk inside the packed files.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const fail = (message) => {
  console.error(`smoke: FAIL -- ${message}`);
  process.exit(1);
};

// 1. The main ESM chunk, and everything it imports statically, is free of `node:` imports
// in EITHER spelling. The lazy Node chunk must import builtins WITH the `node:` prefix
// (tsup.config.ts sets `removeNodeProtocol: false`): Deno and Cloudflare Workers resolve
// Node built-ins only that way, so a bare "fs" there would silently break `push`/`pull`
// even though `node:fs` exists.
const dist = join(root, "dist");
if (!existsSync(join(dist, "index.js"))) fail("dist/index.js is missing; run `npm run build` first");
const staticImports = (source) =>
  [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*"([^"]+)"|(?:^|\n)\s*import\s*"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
// A bare name (e.g. "fs") is still a Node builtin -- some bundler configuration could strip
// the prefix again -- so the main-graph walk below catches both spellings.
const builtins = new Set(builtinModules);
const isNodeImport = (spec) => spec.startsWith("node:") || builtins.has(spec);
const seen = new Set();
const queue = ["./index.js"];
while (queue.length > 0) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  for (const spec of staticImports(readFileSync(join(dist, file), "utf8"))) {
    if (isNodeImport(spec)) fail(`${file} statically imports ${spec}; only the lazy Node chunk may`);
    if (spec.startsWith("./")) queue.push(spec);
  }
}
// This scan covers the ESM chunks only, on purpose: the "node:" prefix matters for Deno and
// Cloudflare Workers, which never load the CJS build, and `staticImports`'s regex only
// understands `import … from "…"`, not `require("…")` -- the CJS chunk is not walked here.
const lazy = readdirSync(dist).filter((f) => f.endsWith(".js") && !seen.has(`./${f}`));
for (const file of lazy) {
  for (const spec of staticImports(readFileSync(join(dist, file), "utf8"))) {
    if (builtins.has(spec)) {
      fail(`${file} imports the Node builtin "${spec}" without the "node:" prefix -- check tsup.config.ts's removeNodeProtocol`);
    }
  }
}
if (!lazy.some((f) => staticImports(readFileSync(join(dist, f), "utf8")).includes("node:fs"))) {
  fail("no lazily loaded chunk imports node:fs -- the static-import check above would be vacuous");
}
console.log(`smoke: static graph ${[...seen].join(", ")} has no Node builtin imports; lazy: ${lazy.join(", ")} imports builtins with the "node:" prefix`);

// 2. Pack, install the tarball elsewhere, and use it from CJS and from ESM.
const work = mkdtempSync(join(tmpdir(), "artefaktum-smoke-"));
try {
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" }));
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", join(work, filename)], { cwd: work, stdio: "pipe" });

  const installed = join(work, "node_modules", "artefaktum");
  const shipped = readdirSync(installed).sort();
  if (shipped.join() !== ["LICENSE", "README.md", "dist", "package.json"].join()) fail(`unexpected files in the tarball: ${shipped}`);

  const body = `
    const http = require("node:http");
    const fs = require("node:fs");
    const path = require("node:path");
    const assert = require("node:assert/strict");
    const PROJECT = "0198f3c2-0000-7000-8000-000000000001";
    async function main(sdk, label) {
      assert.equal(sdk.VERSION, ${JSON.stringify(pkg.version)});
      assert.equal(typeof sdk.Artefaktum, "function");
      assert.equal(new sdk.NotFoundError("x").name, "NotFoundError");
      assert.ok(new sdk.NotFoundError("x") instanceof sdk.ArtefaktumError);
      assert.deepEqual([...sdk.RELATION_TYPES].sort(), ["attachment_of", "derived_from", "generated_by", "related_to", "supersedes"]);
      const saved = process.env.ARTEFAKTUM_API_KEY; delete process.env.ARTEFAKTUM_API_KEY;
      assert.throws(() => new sdk.Artefaktum(), (e) => e.name === "MissingApiKeyError");
      if (saved !== undefined) process.env.ARTEFAKTUM_API_KEY = saved;

      const calls = [];
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          calls.push({ method: req.method, url: req.url, headers: req.headers, size: Buffer.concat(chunks).length });
          const base = "http://127.0.0.1:" + server.address().port;
          const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
          const ref = { id: "a1", version_id: "v1", status: "processing" };
          if (req.url === "/v1/artifacts/uploads") return send(201, { artifact: ref, upload: { method: "PUT", url: base + "/storage/obj?sig=SECRET", headers: { "Content-Type": "text/plain" }, expires_at: "2030-01-01T00:00:00Z" } });
          if (req.url.startsWith("/storage/")) { res.writeHead(200); return res.end(); }
          if (req.url.endsWith("/complete")) return send(200, ref);
          if (req.url === "/v1/artifacts/a1") return send(200, { id: "a1", status: "ready", title: "smoke" });
          send(404, { code: "not_found", detail: req.url });
        });
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      try {
        const file = path.join(__dirname, label + ".txt");
        fs.writeFileSync(file, "hello from the smoke test");
        const client = new sdk.Artefaktum({ apiKey: "afk_smoke", baseUrl: "http://127.0.0.1:" + server.address().port, project: PROJECT });
        const artifact = await client.artifacts.push(file, { title: "smoke" });
        assert.equal(artifact.status, "ready");
        const put = calls.find((c) => c.method === "PUT");
        assert.equal(put.headers["content-length"], "25");
        assert.equal(put.headers["transfer-encoding"], undefined);
        assert.equal(put.headers["authorization"], undefined);
        assert.equal(put.size, 25);
        assert.equal(calls[0].headers["authorization"], "Bearer afk_smoke");
        await assert.rejects(client.artifacts.get("missing"), (e) => e instanceof sdk.NotFoundError && e.code === "not_found");
      } finally {
        await new Promise((r) => server.close(r));
      }
      console.log("smoke: " + label + " ok");
    }
  `;
  writeFileSync(join(work, "cjs.cjs"), `${body}\nmain(require("artefaktum"), "cjs").catch((e) => { console.error(e); process.exit(1); });\n`);
  writeFileSync(
    join(work, "esm.mjs"),
    `import { createRequire } from "node:module";\nimport { dirname } from "node:path";\nimport { fileURLToPath } from "node:url";\nimport * as sdk from "artefaktum";\nconst require = createRequire(import.meta.url);\nconst __dirname = dirname(fileURLToPath(import.meta.url));\n${body}\nmain(sdk, "esm").catch((e) => { console.error(e); process.exit(1); });\n`,
  );
  execFileSync(process.execPath, ["cjs.cjs"], { cwd: work, stdio: "inherit" });
  execFileSync(process.execPath, ["esm.mjs"], { cwd: work, stdio: "inherit" });
  console.log("smoke: PASS");
} finally {
  rmSync(work, { recursive: true, force: true });
}
