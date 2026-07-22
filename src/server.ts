import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { NTNUClient } from "ntnu-api";
import { TTLCache } from "./cache.js";
import type { ToolDeps } from "./deps.js";
// `registerTools` lives in `./mcp-tools.ts`, which has zero static dependency
// on `agents/mcp` — see that file's header comment for why. Re-exported here
// so this module's public surface matches the contract (`registerTools` is
// importable from `src/server.ts`), while `tests/server.test.ts` imports it
// straight from `./mcp-tools.js` to avoid ever loading `agents/mcp` under
// vitest.
import { registerTools } from "./mcp-tools.js";

export { registerTools };

/**
 * FastMCP instructions string from `mcp_server.py`, extended with a sentence
 * about the two new comparison/conflict tools so LLM clients discover them.
 */
const INSTRUCTIONS =
  "Course data for NTNU (Norwegian University of Science and Technology): " +
  "catalog search, teaching schedules, weekly timetables, and historical " +
  "grade statistics. Use search_courses first when you don't know the " +
  "exact course code. Use compare_courses to line courses up side by side " +
  "when choosing between them, and check_timetable_conflicts to catch " +
  "schedule and exam clashes before registering.";

/** Module-level singletons shared per isolate. */
const client = new NTNUClient();
const cache = new TTLCache();
const deps: ToolDeps = { client, cache };

export class NtnuMcp extends McpAgent {
  // `agents` bundles its own nested `@modelcontextprotocol/sdk@1.23.0`, distinct
  // from the top-level SDK version this file imports `McpServer` from. Both
  // expose an identical runtime `McpServer`/`registerTool` shape, but their
  // private class fields make the two `McpServer` types nominally
  // incompatible, so `McpAgent`'s abstract `server` property (typed against
  // the nested copy) rejects the top-level one structurally. Cast through
  // `unknown` at this single assignment point; every other use of `server`
  // in this file goes through the top-level `McpServer` type.
  server = new McpServer(
    { name: "ntnu", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  ) as unknown as McpAgent["server"];

  async init(): Promise<void> {
    registerTools(this.server as unknown as McpServer, deps);
  }
}

// `ExecutionContext` is only a global under `@cloudflare/workers-types`, which
// isn't loaded by `tsconfig.test.json` (it clashes with `@types/node`'s
// `fetch`/`Request` globals — see the scaffold's split-tsconfig rationale).
// This file is included by both tsconfigs, so the fetch handler's `ctx`
// parameter uses a minimal structural type instead of the ambient name, kept
// compatible with the real `ExecutionContext` the Workers runtime passes in.
interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async fetch(request: Request, env: unknown, ctx: MinimalExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // `NtnuMcp.serve(...).fetch` wants workers-types' `ExecutionContext`
      // (its `exports`/`props`/`tracing` fields aren't reachable without
      // that type package, absent under tsconfig.test.json — see the note
      // on `MinimalExecutionContext` above). The real runtime object passed
      // in here always satisfies the fuller type; only the checker needs
      // convincing.
      // biome-ignore lint/suspicious/noExplicitAny: bridges MinimalExecutionContext to workers-types' ExecutionContext
      return NtnuMcp.serve("/mcp").fetch(request, env, ctx as any);
    }
    return new Response("Not found", { status: 404 });
  },
};
