/**
 * The test-side half of the drift guard that design spec §10 does not cover: it ties the
 * request bodies (already checked against `Schemas[...]` at compile time) to the paths,
 * methods and query-parameter NAMES that `client.ts` spells as bare strings. None of those
 * are checked by `tsc`, so a server-side route or query-parameter rename would refresh the
 * OpenAPI snapshot, regenerate `schema.gen.ts`, pass every existing check, and 404/422 at
 * runtime. No production code changes: this only exists to fail a test when that happens.
 */
import { readFileSync } from "node:fs";
import type { Recorded } from "./helpers.js";

interface Parameter {
  name: string;
  in: string;
}

interface Operation {
  parameters?: Parameter[];
}

type PathItem = Record<string, Operation>;

interface OpenApiDocument {
  paths: Record<string, PathItem>;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

const openapi: OpenApiDocument = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
) as OpenApiDocument;

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

function isParamSegment(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/** Segment-by-segment: a `{param}` segment matches any single literal segment. */
function templateMatches(template: string, actual: readonly string[]): boolean {
  const templateSegments = segmentsOf(template);
  if (templateSegments.length !== actual.length) return false;
  return templateSegments.every((segment, i) => isParamSegment(segment) || segment === actual[i]);
}

function literalSegmentCount(template: string): number {
  return segmentsOf(template).filter((segment) => !isParamSegment(segment)).length;
}

/**
 * Ties one recorded request to the OpenAPI document: the path template it matches, that its
 * method is declared on that path, and that every query key it sent is a declared `in:
 * "query"` parameter of that operation. Returns `"<METHOD> <template>"` on success; throws a
 * precise `Error` on any miss.
 */
export function assertInOpenApi(recorded: Recorded): string {
  const actual = segmentsOf(recorded.url.pathname);
  const candidates = Object.keys(openapi.paths)
    .filter((template) => templateMatches(template, actual))
    .sort((a, b) => literalSegmentCount(b) - literalSegmentCount(a));

  const template = candidates[0];
  if (template === undefined) {
    throw new Error(`no path in openapi.json matches ${recorded.method} ${recorded.url.pathname}`);
  }

  const method = recorded.method.toLowerCase();
  const operation = openapi.paths[template]?.[method];
  if (!operation) {
    throw new Error(`openapi.json's ${template} has no ${recorded.method} operation (matched by path, not by method)`);
  }

  const declaredQuery = new Set(
    (operation.parameters ?? []).filter((param) => param.in === "query").map((param) => param.name),
  );
  for (const key of recorded.url.searchParams.keys()) {
    if (!declaredQuery.has(key)) {
      throw new Error(
        `query parameter "${key}" is not declared as an "in: query" parameter of ${recorded.method} ${template} in openapi.json`,
      );
    }
  }

  return `${recorded.method} ${template}`;
}

/** Every `"<METHOD> <template>"` operation id declared in openapi.json. */
export function allOperations(): Set<string> {
  const ids = new Set<string>();
  for (const [template, item] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method)) ids.add(`${method.toUpperCase()} ${template}`);
    }
  }
  return ids;
}
