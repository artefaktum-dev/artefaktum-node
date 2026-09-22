import type { Config } from "../src/config.js";

export const CONFIG: Config = {
  apiKey: "afk_test_key",
  baseUrl: "https://api.test",
  project: "default",
  timeoutMs: 1_000,
};

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  /** The JSON-decoded body when it was a JSON string, else the raw body. */
  body: unknown;
  init: RequestInit;
}

export type Reply = Response | Error | ((request: Recorded) => Response | Promise<Response>);

/**
 * A scripted `fetch`: replies are consumed in order, every request is recorded. Running
 * out of replies throws, so a test fails loudly on a request it did not expect.
 */
export function fakeFetch(replies: Reply[]) {
  const queue = [...replies];
  const requests: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let body: unknown = init.body;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const recorded: Recorded = {
      method: init.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init.headers),
      body,
      init,
    };
    requests.push(recorded);
    const reply = queue.shift();
    if (reply === undefined) throw new Error(`unexpected request: ${recorded.method} ${recorded.url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply(recorded) : reply;
  }) as typeof globalThis.fetch;
  return { fetch, requests, remaining: () => queue.length };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function problem(status: number, code: string, detail = "nope", headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ type: `https://artefact.ai/errors/${code}`, title: code, status, detail, code, request_id: "req_test" }),
    { status, headers: { "content-type": "application/problem+json", ...headers } },
  );
}

export function empty(status = 202): Response {
  return new Response(null, { status });
}
