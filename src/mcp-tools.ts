/**
 * Registers all ten NTNU tools on an `McpServer`. Split out of `server.ts`
 * so it has zero static dependency on `agents/mcp`: that package's module
 * graph transitively does a top-level `import ... from "cloudflare:email"`
 * (dead code on our path — we use none of its email-routing features), which
 * only resolves inside the real Workers runtime. `server.ts` is Wrangler's
 * entry point and must statically import `agents/mcp` for the `McpAgent`
 * Durable Object class, so any module that imports `server.ts` inherits that
 * crash under plain Node/vitest. Importing `registerTools` from *this*
 * module instead — as `tests/server.test.ts` does — lets the test run in
 * plain vitest with no workers pool, per the contract. `server.ts` re-exports
 * `registerTools` from here so its own public surface is unchanged.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compareCourses } from "./compare.js";
import { checkTimetableConflicts } from "./conflicts.js";
import { type ToolDeps, UpstreamError } from "./deps.js";
import { getCourseInfo, getExamInfo } from "./details.js";
import {
  getCourseSchedule,
  getCourseVersions,
  getGradeDistribution,
  getSemesters,
  getWeeklyTimetable,
  searchCourses,
} from "./tools.js";

/**
 * Registers all ten NTNU tools on `server`, delegating to the pure tool
 * functions in `./tools.ts`, `./compare.ts`, and `./conflicts.ts`. Exported
 * so tests can register against a bare `McpServer` wired to fixture-backed
 * `ToolDeps`, without spinning up the Durable Object / Workers runtime.
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const asToolResult = (result: object) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  });

  const asToolError = (err: unknown) => {
    if (err instanceof UpstreamError) {
      return {
        content: [{ type: "text" as const, text: err.message }],
        isError: true as const,
      };
    }
    throw err;
  };

  server.registerTool(
    "search_courses",
    {
      description:
        "Search NTNU's course catalog for a given year (server-side free-text search " +
        "over course names and codes; Norwegian terms often match best, e.g. " +
        "'maskinlæring' rather than 'machine learning'). Call this first when you " +
        "don't know the exact course code. Returns course codes, Norwegian names, " +
        "campus, and exam dates.",
      inputSchema: {
        year: z.number().int(),
        query: z.string().nullish(),
        page: z.number().int().optional(),
      },
    },
    async ({ year, query, page }) => {
      try {
        return asToolResult(await searchCourses(deps, { year, query, page }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_course_schedule",
    {
      description:
        "Every dated teaching activity (lectures, labs) for a course in a year, " +
        "with Oslo-local times and rooms. Long output for large courses — prefer " +
        "get_weekly_timetable for a compact recurring-week overview.",
      inputSchema: {
        course_code: z.string(),
        year: z.number().int(),
      },
    },
    async ({ course_code, year }) => {
      try {
        return asToolResult(await getCourseSchedule(deps, { course_code, year }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_weekly_timetable",
    {
      description:
        "The recurring weekly timetable grid for a course in a year: weekday, " +
        "times, ISO-week ranges, and rooms. The compact way to answer 'when are " +
        "the lectures for X'.",
      inputSchema: {
        course_code: z.string(),
        year: z.number().int(),
      },
    },
    async ({ course_code, year }) => {
      try {
        return asToolResult(await getWeeklyTimetable(deps, { course_code, year }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_grade_distribution",
    {
      description:
        "Historical grade distribution for an NTNU course (per year and semester, " +
        "with counts and percentages; grades A-F, or pass/fail codes). Accepts bare " +
        "codes like 'TDT4100'. Omit years to get all recorded years. Small counts " +
        "may be privacy-masked. Data comes from Norway's official DBH statistics.",
      inputSchema: {
        course_code: z.string(),
        years: z.array(z.number().int()).nullish(),
      },
    },
    async ({ course_code, years }) => {
      try {
        return asToolResult(await getGradeDistribution(deps, { course_code, years }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_course_versions",
    {
      description:
        "The DBH-versioned course codes (like 'TDT4100-1') that exist for a bare " +
        "NTNU course code. Useful when grade lookups come back empty.",
      inputSchema: {
        course_code: z.string(),
      },
    },
    async ({ course_code }) => {
      try {
        return asToolResult(await getCourseVersions(deps, { course_code }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_semesters",
    {
      description:
        "NTNU's terms (semesters) with ids like '26h' (autumn 2026) / '26v' " +
        "(spring), teaching weeks, exam-period dates, and which term is current.",
      inputSchema: {},
    },
    async () => {
      try {
        return asToolResult(await getSemesters(deps));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_course_info",
    {
      description:
        "Everything about an NTNU course except exam logistics: credits, level, " +
        "campus, language of instruction, prerequisites, mandatory activities, " +
        "course content / learning outcomes, credit reductions ('studiepoengreduksjon'), " +
        "which study programs the teaching is planned for, contacts, and any alert " +
        "notices (e.g. 'no longer taught'). English text by default; pass language " +
        "'nb' for Norwegian. Omit year for the current study year. For exam dates, " +
        "times, aid codes, and rooms use get_exam_info.",
      inputSchema: {
        course_code: z.string(),
        year: z.number().int().nullish(),
        language: z.enum(["nb", "en"]).nullish(),
      },
    },
    async ({ course_code, year, language }) => {
      try {
        return asToolResult(await getCourseInfo(deps, { course_code, year, language }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "get_exam_info",
    {
      description:
        "Exam logistics for one or more NTNU courses in a single call: every exam " +
        "occasion (ordinary / re-sit) with date, start time, duration, permitted-aids " +
        "code ('hjelpemiddelkode') with its meaning, exam system, and assigned rooms. " +
        "The way to answer 'when and where are my exams and what can I bring' for a " +
        "whole semester at once. Rooms are only published days before the exam; " +
        "unpublished fields are null. Omit year for the current study year.",
      inputSchema: {
        course_codes: z.array(z.string()).min(1),
        year: z.number().int().nullish(),
        language: z.enum(["nb", "en"]).nullish(),
      },
    },
    async ({ course_codes, year, language }) => {
      try {
        return asToolResult(await getExamInfo(deps, { course_codes, year, language }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "compare_courses",
    {
      description:
        "Side-by-side comparison of NTNU courses for a given year — campus, exam " +
        "dates, weekly teaching hours, and latest grade distribution — to help " +
        "choose between courses. Accepts bare course codes.",
      inputSchema: {
        course_codes: z.array(z.string()).min(1),
        year: z.number().int(),
      },
    },
    async ({ course_codes, year }) => {
      try {
        return asToolResult(await compareCourses(deps, { course_codes, year }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "check_timetable_conflicts",
    {
      description:
        "Checks a set of NTNU courses for the same year for clashing lecture/lab " +
        "times and colliding exam dates — a clash check to run before registering " +
        "for courses. Accepts bare course codes.",
      inputSchema: {
        course_codes: z.array(z.string()).min(2),
        year: z.number().int(),
      },
    },
    async ({ course_codes, year }) => {
      try {
        return asToolResult(await checkTimetableConflicts(deps, { course_codes, year }));
      } catch (err) {
        return asToolError(err);
      }
    },
  );
}
