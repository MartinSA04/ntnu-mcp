import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Fetch } from "ntnu-api";
import { NTNUClient } from "ntnu-api";
import { TTLCache } from "../src/cache.js";
import type { ToolDeps } from "../src/deps.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Loads and parses `tests/fixtures/<name>.json`. */
export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}.json`, "utf-8"));
}

/** Builds a `Response` carrying JSON, mirroring `fetch`'s Response shape. */
export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * A recording `fetch` stand-in that dispatches by matching the request URL
 * against a substring, in registration order (first match wins).
 */
type FetchInput = Parameters<Fetch>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

export function routeFetch(
  routes: Array<{ match: string; respond: (url: string, init?: RequestInit) => Response }>,
): { fetch: Fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: Fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) {
      throw new Error(`routeFetch: no route matched ${url}`);
    }
    return route.respond(url, init);
  }) as Fetch;
  return { fetch, calls };
}

/**
 * A recording `fetch` stand-in that returns fixed responses in sequence
 * (one per call, repeating the last one once exhausted).
 */
export function sequenceFetch(responses: Response[]): { fetch: Fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: Fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push({ url, init });
    const idx = Math.min(calls.length - 1, responses.length - 1);
    const response = responses[idx];
    if (!response) {
      throw new Error("sequenceFetch: no responses configured");
    }
    return response.clone();
  }) as Fetch;
  return { fetch, calls };
}

const noopSleep = async (_ms: number): Promise<void> => {};

/** Builds `ToolDeps` wired to a fixture-backed `NTNUClient` and a fresh `TTLCache`. */
export function makeDeps(fetchImpl: Fetch, now?: () => Date): ToolDeps {
  const client = new NTNUClient({ fetch: fetchImpl, sleep: noopSleep });
  const cache = new TTLCache();
  return now ? { client, cache, now } : { client, cache };
}
