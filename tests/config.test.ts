import { describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, isUuid, loadConfig } from "../src/config.js";
import { MissingApiKeyError } from "../src/errors.js";

describe("loadConfig", () => {
  it("prefers options over the environment over defaults", () => {
    const env = { ARTEFAKTUM_API_KEY: "env-key", ARTEFAKTUM_BASE_URL: "https://env.example", ARTEFAKTUM_PROJECT: "env-proj" };
    expect(loadConfig({}, env)).toEqual({ apiKey: "env-key", baseUrl: "https://env.example", project: "env-proj", timeoutMs: 30_000 });
    expect(loadConfig({ apiKey: "k", baseUrl: "https://opt.example", project: "p", timeoutMs: 5 }, env)).toEqual({
      apiKey: "k", baseUrl: "https://opt.example", project: "p", timeoutMs: 5,
    });
  });

  it("defaults the base URL and the project", () => {
    expect(loadConfig({ apiKey: "k" }, {})).toEqual({ apiKey: "k", baseUrl: DEFAULT_BASE_URL, project: "default", timeoutMs: 30_000 });
    expect(DEFAULT_BASE_URL).toBe("https://api.artefaktum.dev");
  });

  it("strips trailing slashes from the base URL", () => {
    expect(loadConfig({ apiKey: "k", baseUrl: "http://localhost:3000//" }, {}).baseUrl).toBe("http://localhost:3000");
  });

  it.each(["api.artefaktum.dev", "localhost:8000", "ftp://x.example", "not a url"])(
    "rejects a baseUrl option that is not an absolute http(s) URL: %s",
    (baseUrl) => {
      expect(() => loadConfig({ apiKey: "k", baseUrl })).toThrow(TypeError);
      expect(() => loadConfig({ apiKey: "k", baseUrl })).toThrow(/baseUrl must be an absolute http\(s\) URL/);
      expect(() => loadConfig({ apiKey: "k", baseUrl })).toThrow(new RegExp(baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    },
  );

  it.each(["api.artefaktum.dev", "localhost:8000", "ftp://x.example", "not a url"])(
    "rejects the same values from ARTEFAKTUM_BASE_URL: %s",
    (baseUrl) => {
      expect(() => loadConfig({ apiKey: "k" }, { ARTEFAKTUM_BASE_URL: baseUrl })).toThrow(
        /baseUrl must be an absolute http\(s\) URL/,
      );
    },
  );

  it("still loads valid http(s) base URLs, trailing slash and all", () => {
    expect(loadConfig({ apiKey: "k", baseUrl: "http://localhost:3000" }).baseUrl).toBe("http://localhost:3000");
    expect(loadConfig({ apiKey: "k", baseUrl: "https://api.artefaktum.dev/" }).baseUrl).toBe("https://api.artefaktum.dev");
  });

  it("throws before any request when there is no key", () => {
    expect(() => loadConfig({}, {})).toThrow(MissingApiKeyError);
    expect(() => loadConfig({ apiKey: "" }, {})).toThrow(MissingApiKeyError);
  });

  it("reads process.env when no env is passed", () => {
    const before = process.env.ARTEFAKTUM_API_KEY;
    process.env.ARTEFAKTUM_API_KEY = "from-process";
    try {
      expect(loadConfig().apiKey).toBe("from-process");
    } finally {
      if (before === undefined) delete process.env.ARTEFAKTUM_API_KEY;
      else process.env.ARTEFAKTUM_API_KEY = before;
    }
  });
});

describe("isUuid", () => {
  it.each([
    ["0198f3c2-7a1b-7c3d-9e4f-0123456789ab", true],
    ["0198F3C2-7A1B-7C3D-9E4F-0123456789AB", true],
    ["default", false],
    ["0198f3c2-7a1b-7c3d-9e4f-0123456789a", false],
    ["", false],
  ])("isUuid(%j) is %j", (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });
});
