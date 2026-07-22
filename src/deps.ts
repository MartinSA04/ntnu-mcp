import type { NTNUClient } from "ntnu-api";
import type { TTLCache } from "./cache.js";

/**
 * Dependencies threaded through every pure tool function, so tests can swap
 * in a fixture-backed `NTNUClient` and a fresh `TTLCache` without touching
 * module-level singletons.
 */
export interface ToolDeps {
  client: NTNUClient;
  cache: TTLCache;
  /** Injectable clock for the semester "current" heuristic; defaults to the wall clock. */
  now?: () => Date;
}

/**
 * Raised when an upstream `ntnu-api` call fails. The server layer maps this
 * to an MCP tool error result (`isError: true`) instead of throwing across
 * the protocol boundary.
 */
export class UpstreamError extends Error {}
