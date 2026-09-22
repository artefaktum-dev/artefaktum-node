import { describe, expect, it } from "vitest";
import { contentTypeFor } from "../src/mime.js";

describe("contentTypeFor", () => {
  it.each([
    ["report.pdf", "application/pdf"],
    ["data.CSV", "text/csv"],
    ["notes.md", "text/markdown"],
    ["a/b/c.json", "application/json"],
    ["archive.tar.gz", "application/gzip"],
    ["table.parquet", "application/vnd.apache.parquet"],
    ["photo.jpeg", "image/jpeg"],
    ["page.html", "text/html"],
    ["lines.jsonl", "application/x-ndjson"],
    ["README", "application/octet-stream"],
    ["weird.zzz", "application/octet-stream"],
    [".gitignore", "application/octet-stream"],
    ["", "application/octet-stream"],
  ])("%s → %s", (filename, expected) => {
    expect(contentTypeFor(filename)).toBe(expected);
  });
});
