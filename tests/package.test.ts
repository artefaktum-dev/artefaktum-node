import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  dependencies?: Record<string, string>;
};

describe("package", () => {
  it("exports the version package.json declares", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("has no runtime dependencies", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  // The snapshot -> types half of the drift guard (design spec §10).
  it("has generated types that match the OpenAPI snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "artefaktum-gen-"));
    try {
      const out = join(dir, "schema.gen.ts");
      const bin = join(root, "node_modules", ".bin", "openapi-typescript");
      execFileSync(bin, ["openapi.json", "-o", out], { cwd: root, stdio: "pipe" });
      expect(readFileSync(join(root, "src", "schema.gen.ts"), "utf8")).toBe(readFileSync(out, "utf8"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
