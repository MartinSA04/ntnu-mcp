/**
 * Cached wrappers around every `ntnu-api` call the tools make. All upstream
 * traffic goes through here so each NTNU/DBH/TP resource is fetched at most
 * once per TTL (per isolate without KV, roughly once globally with it) no
 * matter which tools ask — `get_weekly_timetable`, `compare_courses`, and
 * `check_timetable_conflicts` all share one cached timetable, for example.
 * This exists to minimize load on NTNU's servers, which are an internal AJAX
 * surface, not a public API.
 *
 * Caching lives at this layer (raw client results) rather than per tool so
 * results are reusable across tools; shaping is cheap CPU and re-runs freely.
 * The one exception is `get_semesters`, which still caches its shaped result
 * in `tools.ts` (its two client calls are inseparable there).
 */

import type { CourseSearchPage, GradeRow, ScheduleActivity, TimetableEntry } from "ntnu-api";
import {
  GRADES_CACHE_TTL_MS,
  SCHEDULE_CACHE_TTL_MS,
  SEARCH_CACHE_TTL_MS,
  TIMETABLE_CACHE_TTL_MS,
} from "./cache.js";
import type { ToolDeps } from "./deps.js";

/** One page of catalog search, cached 1h under the normalized query. */
export async function cachedSearch(
  deps: ToolDeps,
  year: number,
  query: string | null,
  page = 1,
): Promise<CourseSearchPage> {
  const key = JSON.stringify(["search", year, query, page]);
  const hit = await deps.cache.get(key, SEARCH_CACHE_TTL_MS);
  if (hit !== null) return hit as CourseSearchPage;
  const value = await deps.client.courses.search(year, query, { page });
  await deps.cache.set(key, value, SEARCH_CACHE_TTL_MS);
  return value;
}

/** A course's weekly timetable grid, cached 1h under the normalized code. */
export async function cachedTimetable(
  deps: ToolDeps,
  courseCode: string,
  year: number,
): Promise<TimetableEntry[]> {
  const key = JSON.stringify(["timetable", courseCode.trim().toUpperCase(), year]);
  const hit = await deps.cache.get(key, TIMETABLE_CACHE_TTL_MS);
  if (hit !== null) return hit as TimetableEntry[];
  const value = await deps.client.courses.timetable(courseCode, year);
  await deps.cache.set(key, value, TIMETABLE_CACHE_TTL_MS);
  return value;
}

/**
 * A course's dated teaching activities, cached 1h. `start`/`end` are `Date`s,
 * which JSON-stringify to ISO strings on the KV round-trip — revived here so
 * callers always see `Date`s regardless of which tier answered.
 */
export async function cachedSchedules(
  deps: ToolDeps,
  courseCode: string,
  year: number,
): Promise<ScheduleActivity[]> {
  const key = JSON.stringify(["schedules", courseCode.trim().toUpperCase(), year]);
  const hit = await deps.cache.get(key, SCHEDULE_CACHE_TTL_MS);
  if (hit !== null) return (hit as ScheduleActivity[]).map(reviveActivity);
  const value = await deps.client.courses.schedules(courseCode, year);
  await deps.cache.set(key, value, SCHEDULE_CACHE_TTL_MS);
  return value;
}

function reviveActivity(a: ScheduleActivity): ScheduleActivity {
  return {
    ...a,
    start: a.start instanceof Date ? a.start : new Date(a.start as unknown as string),
    end: a.end instanceof Date ? a.end : new Date(a.end as unknown as string),
  };
}

/** DBH grade rows for a course, cached 24h under the normalized code + years. */
export async function cachedGrades(
  deps: ToolDeps,
  courseCode: string,
  years?: number[] | null,
): Promise<GradeRow[]> {
  const key = JSON.stringify(["grades", courseCode.trim().toUpperCase(), years ?? null]);
  const hit = await deps.cache.get(key, GRADES_CACHE_TTL_MS);
  if (hit !== null) return hit as GradeRow[];
  const value = await deps.client.grades.distribution(
    courseCode,
    years ? { years } : undefined,
  );
  await deps.cache.set(key, value, GRADES_CACHE_TTL_MS);
  return value;
}

/** DBH-versioned course codes for a bare code, cached 24h. */
export async function cachedCourseVersions(
  deps: ToolDeps,
  courseCode: string,
): Promise<string[]> {
  const key = JSON.stringify(["versions", courseCode.trim().toUpperCase()]);
  const hit = await deps.cache.get(key, GRADES_CACHE_TTL_MS);
  if (hit !== null) return hit as string[];
  const value = await deps.client.grades.courseVersions(courseCode);
  await deps.cache.set(key, value, GRADES_CACHE_TTL_MS);
  return value;
}
