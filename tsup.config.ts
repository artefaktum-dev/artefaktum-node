import { defineConfig } from "tsup";

// `splitting` keeps `files.node.ts` (the only module that imports `node:*`) in its own
// chunk in BOTH formats, reached by a dynamic import, so the main chunk loads on runtimes
// without Node's built-ins. `scripts/smoke.mjs` asserts it.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  // Keep the `node:` prefix on built-in imports in the lazy chunk: Deno and Cloudflare
  // Workers resolve Node built-ins only with the prefix, and every Node version we support
  // (>= 20) understands it too, so stripping it (tsup's default) only costs portability.
  removeNodeProtocol: false,
});
