import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
// Imported from `./mcp-tools.js`, NOT `../src/server.js`: `server.ts` also
// statically imports `agents/mcp` (for the `McpAgent`/`NtnuMcp` Durable
// Object class Wrangler needs), and that package's module graph does a
// top-level `import ... from "cloudflare:email"` that only resolves inside
// the real Workers runtime — plain Node/vitest errors with "Only URLs with a
// scheme in: file, data, and node are supported". `registerTools` has no
// dependency on `agents`, so importing it from its actual home module keeps
// this test running in plain vitest with no workers pool, per the contract.
import { registerTools } from "../src/mcp-tools.js";
import { jsonResponse, loadFixture, makeDeps, routeFetch } from "./helpers.js";

const TEN_TOOL_NAMES = [
  "get_course_info",
  "get_exam_info",
  "search_courses",
  "get_course_schedule",
  "get_weekly_timetable",
  "get_grade_distribution",
  "get_course_versions",
  "get_semesters",
  "compare_courses",
  "check_timetable_conflicts",
];

/** Wires a bare McpServer + registerTools(deps) to a Client over an in-memory transport. */
async function connectedClient(deps: Parameters<typeof registerTools>[1]) {
  const server = new McpServer({ name: "ntnu-test", version: "0.0.0" });
  registerTools(server, deps);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server };
}

describe("registerTools", () => {
  it("registers exactly the ten NTNU tools", async () => {
    const { fetch } = routeFetch([]);
    const deps = makeDeps(fetch);
    const { client } = await connectedClient(deps);

    const { tools } = await client.listTools();
    expect(new Set(tools.map((t) => t.name))).toEqual(new Set(TEN_TOOL_NAMES));
  });

  it("calls search_courses end-to-end and parses the JSON text content", async () => {
    const { fetch } = routeFetch([
      { match: "emnesok", respond: () => jsonResponse(loadFixture("catalog_page")) },
    ]);
    const deps = makeDeps(fetch);
    const { client } = await connectedClient(deps);

    const result = await client.callTool({
      name: "search_courses",
      arguments: { year: 2026, query: "objektorientert" },
    });

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const [entry] = content;
    if (!entry) throw new Error("expected one content entry");
    expect(entry.type).toBe("text");
    const parsed = JSON.parse(entry.text);
    expect(parsed.num_found).toBe(4767);
    const tdt = parsed.courses.find((c: { code: string }) => c.code === "TDT4100");
    expect(tdt.name).toBe("Objektorientert programmering");
  });

  it("maps an upstream 500 to isError: true", async () => {
    const { fetch } = routeFetch([
      { match: "emnesok", respond: () => new Response("boom", { status: 500 }) },
    ]);
    const deps = makeDeps(fetch);
    const { client } = await connectedClient(deps);

    const result = await client.callTool({
      name: "search_courses",
      arguments: { year: 2026, query: "x" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const [entry] = content;
    if (!entry) throw new Error("expected one content entry");
    expect(entry.text).toMatch(/catalog request failed/);
  });
});
