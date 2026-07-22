/**
 * The six NTNU MCP tools, ported 1:1 from the Python FastMCP tools in
 * `ntnu_api/mcp_server.py`: pure async functions over {@link ToolDeps} so
 * the server layer can register them without any lifespan/context plumbing,
 * and tests can call them directly.
 *
 * Result shapes are LLM-facing and therefore keep Python's snake_case keys
 * verbatim (`num_found`, `has_more_pages`, `course_code`, ...); guidance
 * `note` strings and cache keys/TTLs are copied verbatim from the Python
 * original for parity.
 */

import { bestName, NTNUAPIError } from "ntnu-api";
import { SEMESTERS_CACHE_TTL_MS } from "./cache.js";
import type { ToolDeps } from "./deps.js";
import { UpstreamError } from "./deps.js";
import { gradeTables, shapeActivity, shapeSlot } from "./shaping.js";
import {
  cachedCourseVersions,
  cachedGrades,
  cachedSchedules,
  cachedSearch,
  cachedTimetable,
} from "./upstream.js";

/** Max courses returned per `search_courses` call (ports `SEARCH_RESULT_LIMIT`). */
export const SEARCH_RESULT_LIMIT = 50;

/**
 * Search NTNU's course catalog for a given year (server-side free-text
 * search over course names and codes; Norwegian terms often match best,
 * e.g. 'maskinlæring' rather than 'machine learning'). Call this first when
 * you don't know the exact course code. Returns course codes, Norwegian
 * names, campus, and exam dates.
 */
export async function searchCourses(
  deps: ToolDeps,
  args: { year: number; query?: string | null; page?: number },
): Promise<object> {
  const query = args.query ?? null;
  const page = args.page ?? 1;
  // Caching happens in `cachedSearch` (upstream level), so the raw page is
  // reusable by compare_courses/check_timetable_conflicts; shaping re-runs.
  let pageData: Awaited<ReturnType<typeof cachedSearch>>;
  try {
    pageData = await cachedSearch(deps, args.year, query, page);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`NTNU catalog request failed: ${exc.message}`);
    }
    throw exc;
  }
  const hits = pageData.courses.slice(0, SEARCH_RESULT_LIMIT);
  const shaped: Record<string, unknown> = {
    num_found: pageData.numFound,
    page,
    has_more_pages: pageData.hasMoreResults,
    showing: hits.length,
    courses: hits.map((hit) => ({
      code: hit.courseCode,
      name: hit.courseName,
      campus: hit.location,
      exams: hit.exams.map((e) => ({ date: e.date ?? null, season: e.season })),
    })),
  };
  if (pageData.courses.length > SEARCH_RESULT_LIMIT) {
    shaped.note =
      `Showing first ${SEARCH_RESULT_LIMIT} of ${pageData.courses.length} results on ` +
      "this page; narrow the query or request a later page.";
  }
  return shaped;
}

/**
 * Every dated teaching activity (lectures, labs) for a course in a year,
 * with Oslo-local times and rooms. Long output for large courses — prefer
 * get_weekly_timetable for a compact recurring-week overview.
 */
export async function getCourseSchedule(
  deps: ToolDeps,
  args: { course_code: string; year: number },
): Promise<object> {
  let activities: Awaited<ReturnType<typeof cachedSchedules>>;
  try {
    activities = await cachedSchedules(deps, args.course_code, args.year);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`NTNU schedule request failed: ${exc.message}`);
    }
    throw exc;
  }
  if (activities.length === 0) {
    return {
      course_code: args.course_code.toUpperCase(),
      year: args.year,
      activities: [],
      note:
        "No schedule found — unknown course code, or the schedule " +
        "for this year is not published yet. Use search_courses to verify the code.",
    };
  }
  const sorted = [...activities].sort((a, b) => a.start.getTime() - b.start.getTime());
  const first = sorted[0];
  if (!first) {
    // Unreachable: `activities.length === 0` returned above.
    throw new UpstreamError("NTNU schedule request failed: no activities after filtering");
  }
  const name = bestName(first.courseName, "eng");
  return {
    course_code: args.course_code.toUpperCase(),
    course_name: name,
    year: args.year,
    activities: sorted.map((a) => shapeActivity(a)),
  };
}

/**
 * The recurring weekly timetable grid for a course in a year: weekday,
 * times, ISO-week ranges, and rooms. The compact way to answer 'when are
 * the lectures for X'.
 */
export async function getWeeklyTimetable(
  deps: ToolDeps,
  args: { course_code: string; year: number },
): Promise<object> {
  let entries: Awaited<ReturnType<typeof cachedTimetable>>;
  try {
    entries = await cachedTimetable(deps, args.course_code, args.year);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`NTNU timetable request failed: ${exc.message}`);
    }
    throw exc;
  }
  if (entries.length === 0) {
    return {
      course_code: args.course_code.toUpperCase(),
      year: args.year,
      slots: [],
      note:
        "No timetable found — unknown course code, or not published " +
        "for this year. Use search_courses to verify the code.",
    };
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.dayNumber !== b.dayNumber) return a.dayNumber - b.dayNumber;
    return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
  });
  const first = entries[0];
  if (!first) {
    // Unreachable: `entries.length === 0` returned above.
    throw new UpstreamError("NTNU timetable request failed: no entries after filtering");
  }
  return {
    course_code: args.course_code.toUpperCase(),
    course_name: bestName(first.courseName, "eng"),
    year: args.year,
    slots: sorted.map((e) => shapeSlot(e)),
  };
}

/**
 * Historical grade distribution for an NTNU course (per year and semester,
 * with counts and percentages; grades A-F, or pass/fail codes). Accepts
 * bare codes like 'TDT4100'. Omit years to get all recorded years. Small
 * counts may be privacy-masked. Data comes from Norway's official DBH
 * statistics.
 */
export async function getGradeDistribution(
  deps: ToolDeps,
  args: { course_code: string; years?: number[] | null },
): Promise<object> {
  let rows: Awaited<ReturnType<typeof cachedGrades>>;
  try {
    rows = await cachedGrades(deps, args.course_code, args.years);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`DBH grade statistics request failed: ${exc.message}`);
    }
    throw exc;
  }
  if (rows.length === 0) {
    return {
      course_code: args.course_code.toUpperCase(),
      distributions: [],
      note:
        "No grade data found. The course may be too new, ungraded, or " +
        "the code may be wrong — try get_course_versions or search_courses.",
    };
  }
  return { course_code: args.course_code.toUpperCase(), distributions: gradeTables(rows) };
}

/**
 * The DBH-versioned course codes (like 'TDT4100-1') that exist for a bare
 * NTNU course code. Useful when grade lookups come back empty.
 */
export async function getCourseVersions(
  deps: ToolDeps,
  args: { course_code: string },
): Promise<object> {
  let versions: Awaited<ReturnType<typeof cachedCourseVersions>>;
  try {
    versions = await cachedCourseVersions(deps, args.course_code);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`DBH request failed: ${exc.message}`);
    }
    throw exc;
  }
  return { course_code: args.course_code.toUpperCase(), versions };
}

/**
 * NTNU's terms (semesters) with ids like '26h' (autumn 2026) / '26v'
 * (spring), teaching weeks, exam-period dates, and which term is current.
 */
export async function getSemesters(deps: ToolDeps): Promise<object> {
  const key = "semesters";
  let result = (await deps.cache.get(key, SEMESTERS_CACHE_TTL_MS)) as object | null;
  if (result === null) {
    let semesters: Awaited<ReturnType<ToolDeps["client"]["semesters"]["all"]>>;
    let current: Awaited<ReturnType<ToolDeps["client"]["semesters"]["current"]>>;
    try {
      semesters = await deps.client.semesters.all();
      current = await deps.client.semesters.current(deps.now?.());
    } catch (exc) {
      if (exc instanceof NTNUAPIError) {
        throw new UpstreamError(`TP semester request failed: ${exc.message}`);
      }
      throw exc;
    }
    const sorted = [...semesters].sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    result = {
      current_semester_id: current ? current.id : null,
      semesters: sorted.map((s) => ({
        id: s.id,
        name: s.nameEn || s.name,
        season: s.season,
        year: s.year,
        from: s.fromDate ?? null,
        to: s.toDate ?? null,
        teaching_weeks: s.teachingWeeks,
        exams_until: s.examLastDate ?? null,
      })),
    };
    await deps.cache.set(key, result, SEMESTERS_CACHE_TTL_MS);
  }
  return result;
}
