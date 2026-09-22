import { describe, expect, it } from "vitest";
import type { Recorded } from "./helpers.js";
import { assertInOpenApi } from "./openapi.js";

function recorded(method: string, url: string): Recorded {
  return { method, url: new URL(url), headers: new Headers(), body: undefined, init: {} };
}

describe("assertInOpenApi", () => {
  it("throws when no path in openapi.json matches", () => {
    expect(() => assertInOpenApi(recorded("GET", "https://api.test/v1/artifactz"))).toThrow(
      /no path in openapi\.json matches/,
    );
  });

  it("throws naming an undeclared query parameter", () => {
    expect(() => assertInOpenApi(recorded("GET", "https://api.test/v1/artifacts?projekt_id=x"))).toThrow(
      /"projekt_id"/,
    );
  });

  it("returns the operation id for a request that matches path, method and query", () => {
    expect(assertInOpenApi(recorded("GET", "https://api.test/v1/artifacts?project_id=x&status=ready"))).toBe(
      "GET /v1/artifacts",
    );
  });
});
