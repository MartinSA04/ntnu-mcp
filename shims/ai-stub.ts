/**
 * Build-time stand-in for the `ai` (Vercel AI SDK) package.
 *
 * The installed `agents` SDK (0.2.35) statically imports `client-QZa2Rq0l.js`
 * from `agents/mcp` (for its unrelated `AIChatAgent`/MCP-client-side
 * `getAITools()` helper), which contains a dynamic `import("ai")`. esbuild
 * resolves dynamic imports at bundle time regardless of whether the branch
 * that reaches them is ever executed, so without a real `ai` dependency the
 * Worker fails to bundle even though nothing in `NtnuMcp` (a plain MCP
 * *server*, not an AI-SDK chat client) ever calls that code path.
 *
 * This module is aliased to `"ai"` in `wrangler.jsonc` so esbuild has
 * something to resolve. It only needs to exist, not to work: `jsonSchema`/
 * `tool` are the two names `agents`' dist imports from `"ai"`, but they are
 * only ever invoked from `AIChatAgent`/`ensureJsonSchema()`/`getAITools()`,
 * none of which `NtnuMcp` (extends `McpAgent`, not `AIChatAgent`) reaches.
 * Real `ai` should replace this alias the day something in this repo
 * actually needs the AI SDK.
 */
export function jsonSchema(): never {
  throw new Error("ai-stub: the real 'ai' package is not installed; jsonSchema() is unreachable from NtnuMcp");
}

export function tool(): never {
  throw new Error("ai-stub: the real 'ai' package is not installed; tool() is unreachable from NtnuMcp");
}
