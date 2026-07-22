/**
 * NEW tool (no Python original): `compare_courses`. Side-by-side comparison
 * of several courses in a given year — campus, Norwegian name, exam dates,
 * a typical weekly teaching-hour load, and the latest grade distribution —
 * so an LLM can help a student choose between courses instead of looking
 * each one up individually.
 */
import { bestName } from "ntnu-api";
import type { ToolDeps } from "./deps.js";
import { UpstreamError } from "./deps.js";
import { gradeTables } from "./shaping.js";
import { cachedGrades, cachedSearch, cachedTimetable } from "./upstream.js";

const WEEKLY_HOURS_NOTE =
  "weekly_teaching_hours sums every listed group; students typically attend one lab group.";

/** Parses an upstream "HH:MM" time string into minutes since midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Rounds to two decimal places — just enough to clear binary floating-point
 * noise from the minutes-based sum without losing precision on exact
 * quarter-hour totals (e.g. 15.25h), which a naive round-to-1-decimal would
 * push to 15.3 under JS's round-half-up `Math.round`.
 */
function round1(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Side-by-side comparison of several courses for a given year: campus,
 * Norwegian name, and exam dates (from the catalog search); a typical
 * weekly teaching-hour load (summed from the timetable, in hours); and the
 * most recent grade distribution table (from DBH), when available.
 *
 * Codes are trimmed, uppercased, and deduped (first occurrence wins),
 * preserving the caller's order. A code that neither the catalog search nor
 * the timetable recognizes gets a per-course `note` instead of the usual
 * fields, rather than being dropped from the result.
 */
export async function compareCourses(
  deps: ToolDeps,
  args: { course_codes: string[]; year: number },
): Promise<object> {
  const codes = dedupeCodes(args.course_codes);

  const courses = await Promise.all(codes.map((code) => compareOne(deps, code, args.year)));

  return {
    year: args.year,
    courses,
    note: WEEKLY_HOURS_NOTE,
  };
}

/** Trims, uppercases, and deduplicates course codes, preserving first-seen order. */
function dedupeCodes(rawCodes: string[]): string[] {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const raw of rawCodes) {
    const code = raw.trim().toUpperCase();
    if (code === "" || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

async function compareOne(deps: ToolDeps, code: string, year: number): Promise<object> {
  let searchHit:
    | Awaited<ReturnType<typeof cachedSearch>>["courses"][number]
    | undefined;
  let timetable: Awaited<ReturnType<typeof cachedTimetable>> = [];

  try {
    const page = await cachedSearch(deps, year, code);
    searchHit = page.courses.find((hit) => hit.courseCode.toUpperCase() === code);
    timetable = await cachedTimetable(deps, code, year);
  } catch (err) {
    throw new UpstreamError(`NTNU comparison request failed: ${(err as Error).message}`);
  }

  if (!searchHit && timetable.length === 0) {
    return { code, note: "not found — verify the code with search_courses" };
  }

  const name = searchHit?.courseName ?? null;
  const campus = searchHit?.location ?? null;
  const examDates = (searchHit?.exams ?? []).map((e) => ({
    date: e.date,
    season: e.season,
    continuation: e.continuation,
  }));

  const englishName = timetable[0] ? bestName(timetable[0].courseName) : null;
  const weeklyTeachingHours = timetable.length > 0 ? round1(sumWeeklyHours(timetable)) : null;

  let gradeRows: Awaited<ReturnType<typeof cachedGrades>> = [];
  try {
    gradeRows = await cachedGrades(deps, code);
  } catch (err) {
    throw new UpstreamError(`NTNU comparison request failed: ${(err as Error).message}`);
  }
  const tables = gradeTables(gradeRows);
  const latestGrades = latestGradeTable(tables);

  return {
    code,
    name: englishName ?? name,
    campus,
    exam_dates: examDates,
    weekly_teaching_hours: weeklyTeachingHours,
    latest_grades: latestGrades,
  };
}

/** Sums (end - start) in hours across every listed timetable slot (all groups, unfiltered). */
function sumWeeklyHours(entries: Awaited<ReturnType<typeof cachedTimetable>>): number {
  let totalMinutes = 0;
  for (const entry of entries) {
    totalMinutes += toMinutes(entry.endTime) - toMinutes(entry.startTime);
  }
  return totalMinutes / 60;
}

/** The grade table with the highest (year, semester ?? "") — the most recent — or null. */
function latestGradeTable(
  tables: ReturnType<typeof gradeTables>,
): ReturnType<typeof gradeTables>[number] | null {
  if (tables.length === 0) return null;
  return tables.reduce((latest, candidate) => {
    const latestKey: [number, string] = [latest.year, latest.semester ?? ""];
    const candidateKey: [number, string] = [candidate.year, candidate.semester ?? ""];
    return candidateKey[0] > latestKey[0] ||
      (candidateKey[0] === latestKey[0] && candidateKey[1] > latestKey[1])
      ? candidate
      : latest;
  });
}
