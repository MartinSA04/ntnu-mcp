/**
 * NEW tool (no Python original): `check_timetable_conflicts`. Pairwise
 * weekly-slot overlap detection across several courses' timetables (same
 * weekday, overlapping time range, and intersecting ISO weeks) plus
 * exam-date collisions from the catalog search — a clash check to run
 * before registering for courses.
 */

import type { TimetableEntry } from "ntnu-api";
import { weekNumbers } from "ntnu-api";
import type { ToolDeps } from "./deps.js";
import { UpstreamError } from "./deps.js";
import { DAY_NAMES } from "./shaping.js";
import { cachedSearch, cachedTimetable } from "./upstream.js";

const LAB_NOTE =
  "Lab/exercise slots often have alternative groups, so timetable overlaps involving them may be avoidable.";

/** One expanded weekly timetable slot, tagged with the course it belongs to. */
export interface Slot {
  code: string;
  dayNumber: number;
  startMin: number;
  endMin: number;
  weekSet: Set<number>;
  label: string | null;
}

/** Parses an upstream "HH:MM" time string into minutes since midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((part) => Number.parseInt(part, 10));
  return (h ?? 0) * 60 + (m ?? 0);
}

function formatTime(min: number): string {
  const h = Math.floor(min / 60)
    .toString()
    .padStart(2, "0");
  const m = (min % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * True when two slots overlap: same weekday, overlapping time range
 * (half-open interval comparison — touching endpoints do not conflict),
 * and at least one ISO week in common.
 */
export function slotOverlaps(a: Slot, b: Slot): boolean {
  if (a.dayNumber !== b.dayNumber) return false;
  if (!(a.startMin < b.endMin && b.startMin < a.endMin)) return false;
  for (const week of a.weekSet) {
    if (b.weekSet.has(week)) return true;
  }
  return false;
}

/** The set of ISO weeks two slots have in common, ascending. */
function overlappingWeeks(a: Slot, b: Slot): number[] {
  const weeks: number[] = [];
  for (const week of a.weekSet) {
    if (b.weekSet.has(week)) weeks.push(week);
  }
  weeks.sort((x, y) => x - y);
  return weeks;
}

/**
 * Compresses a list of week numbers back into a range string, e.g.
 * `[2,3,4,5,7]` → `"2-5,7"`. Inverse of the range expansion `weekNumbers`
 * performs on strings like `"2-13"`.
 */
export function weeksToRanges(weeks: number[]): string {
  const sorted = [...new Set(weeks)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const week = sorted[i]!;
    if (week === prev + 1) {
      prev = week;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = week;
    prev = week;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(",");
}

function dayName(dayNumber: number): string {
  return DAY_NAMES[dayNumber] ?? String(dayNumber);
}

function expandSlots(code: string, entries: TimetableEntry[]): Slot[] {
  return entries.map((entry) => ({
    code,
    dayNumber: entry.dayNumber,
    startMin: toMinutes(entry.startTime),
    endMin: toMinutes(entry.endTime),
    weekSet: new Set(weekNumbers(entry)),
    label: entry.title ?? entry.name,
  }));
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

/**
 * Checks a set of courses for weekly-timetable clashes (same day, overlapping
 * time, intersecting ISO weeks) and exam-date collisions, for a given year.
 *
 * Requires at least two distinct course codes after deduping; if fewer than
 * two remain (either because the caller passed fewer, or duplicates
 * collapsed down to one), a result with an explanatory `note` is returned
 * instead of throwing.
 */
export async function checkTimetableConflicts(
  deps: ToolDeps,
  args: { course_codes: string[]; year: number },
): Promise<object> {
  const codes = dedupeCodes(args.course_codes);

  if (codes.length < 2) {
    return {
      year: args.year,
      courses_checked: codes,
      timetable_conflicts: [],
      exam_conflicts: [],
      notes: ["At least 2 distinct course codes are required to check for conflicts."],
    };
  }

  const notes: string[] = [];
  const allSlots: Slot[] = [];

  for (const code of codes) {
    let entries: TimetableEntry[];
    try {
      entries = await cachedTimetable(deps, code, args.year);
    } catch (err) {
      throw new UpstreamError(`NTNU timetable request failed: ${(err as Error).message}`);
    }
    if (entries.length === 0) {
      notes.push(`No published timetable for ${code}`);
      continue;
    }
    allSlots.push(...expandSlots(code, entries));
  }

  const timetableConflicts: object[] = [];
  for (let i = 0; i < allSlots.length; i++) {
    for (let j = i + 1; j < allSlots.length; j++) {
      const a = allSlots[i]!;
      const b = allSlots[j]!;
      if (a.code === b.code) continue;
      if (!slotOverlaps(a, b)) continue;
      timetableConflicts.push({
        courses: [a.code, b.code],
        day: dayName(a.dayNumber),
        weeks: weeksToRanges(overlappingWeeks(a, b)),
        a: {
          course: a.code,
          activity: a.label,
          time: `${formatTime(a.startMin)}-${formatTime(a.endMin)}`,
        },
        b: {
          course: b.code,
          activity: b.label,
          time: `${formatTime(b.startMin)}-${formatTime(b.endMin)}`,
        },
      });
    }
  }

  const examsByDate = new Map<string, Set<string>>();
  for (const code of codes) {
    let page: Awaited<ReturnType<typeof cachedSearch>>;
    try {
      page = await cachedSearch(deps, args.year, code);
    } catch (err) {
      throw new UpstreamError(`NTNU timetable request failed: ${(err as Error).message}`);
    }
    const hit = page.courses.find((c) => c.courseCode.toUpperCase() === code);
    if (!hit) continue;
    for (const exam of hit.exams) {
      if (exam.continuation || !exam.date) continue;
      const set = examsByDate.get(exam.date) ?? new Set<string>();
      set.add(code);
      examsByDate.set(exam.date, set);
    }
  }

  const examConflicts: object[] = [];
  for (const [date, courseSet] of examsByDate) {
    if (courseSet.size >= 2) {
      examConflicts.push({ date, courses: [...courseSet] });
    }
  }
  examConflicts.sort((a, b) =>
    (a as { date: string }).date.localeCompare((b as { date: string }).date),
  );

  notes.push(LAB_NOTE);

  return {
    year: args.year,
    courses_checked: codes,
    timetable_conflicts: timetableConflicts,
    exam_conflicts: examConflicts,
    notes,
  };
}
