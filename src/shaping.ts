/**
 * LLM-facing output shaping (ports the private helpers of `mcp_server.py`:
 * `_rooms`, `_activity`, `_slot`, `_grade_tables`, and the `DAY_NAMES` map).
 *
 * Times are rendered in Europe/Oslo local time via `Intl.DateTimeFormat`
 * (no date-time dependency needed); grade rows are grouped into per-term
 * distribution tables with masked-count and percentage handling identical
 * to the Python original.
 */

import type { GradeRow, Room, ScheduleActivity, TimetableEntry } from "ntnu-api";

/** ISO day-of-week names; 1 = Monday ... 7 = Sunday (mirrors Python `DAY_NAMES`). */
export const DAY_NAMES: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

/** `Intl.DateTimeFormat` part lookup, keyed by part `type`. */
function partsMap(d: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Oslo",
    ...options,
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  return map;
}

/**
 * Formats `d` as `"YYYY-MM-DD HH:mm"` in Europe/Oslo local time (ports
 * `act.start.astimezone(OSLO).strftime("%Y-%m-%d %H:%M")`).
 */
export function osloDateTime(d: Date): string {
  const p = partsMap(d, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * Formats `d` as `"HH:mm"` in Europe/Oslo local time (ports
 * `act.end.astimezone(OSLO).strftime("%H:%M")`).
 */
export function osloTime(d: Date): string {
  const p = partsMap(d, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.hour}:${p.minute}`;
}

/**
 * Renders each room as `"<room> (<building>)"` when a building is known,
 * else the bare room string; rooms without a room identifier are skipped
 * (ports `_rooms`).
 */
export function formatRooms(rooms: Room[]): string[] {
  const out: string[] = [];
  for (const r of rooms) {
    if (!r.room) continue;
    out.push(r.building ? `${r.room} (${r.building})` : r.room);
  }
  return out;
}

/** Shapes a dated teaching activity for `get_course_schedule` (ports `_activity`). */
export function shapeActivity(a: ScheduleActivity): {
  start: string;
  end: string;
  title: string | null;
  type: string | null;
  rooms: string[];
} {
  return {
    start: osloDateTime(a.start),
    end: osloTime(a.end),
    title: a.title || a.name,
    type: a.summary || a.name,
    rooms: formatRooms(a.rooms),
  };
}

/** Shapes a recurring weekly slot for `get_weekly_timetable` (ports `_slot`). */
export function shapeSlot(e: TimetableEntry): {
  day: string;
  start: string;
  end: string;
  title: string | null;
  weeks: string;
  rooms: string[];
} {
  return {
    day: DAY_NAMES[e.dayNumber] ?? String(e.dayNumber),
    start: e.startTime,
    end: e.endTime,
    title: e.title || e.name,
    weeks: e.weeks.join(","),
    rooms: formatRooms(e.rooms),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Groups DBH grade rows into per-(course version, year, semester)
 * distribution tables for `get_grade_distribution` (ports `_grade_tables`).
 *
 * Groups are sorted by `(course_code, year, semester ?? "")`; grades within
 * a group are sorted by grade letter/code. `candidates` sums the unmasked
 * `total`s in the group; a row's `count` is `"masked"` when its `total` is
 * `null`, else the numeric total; `percent` is `round(100 * total /
 * candidates, 1)` when `total` is known and `candidates > 0`, else `null`.
 */
export function gradeTables(rows: GradeRow[]): Array<{
  course_code: string;
  year: number;
  semester: string | null;
  candidates: number;
  grades: Record<string, { count: number | "masked"; percent: number | null }>;
}> {
  const groups = new Map<
    string,
    { code: string; year: number; semester: string | null; rows: GradeRow[] }
  >();
  for (const row of rows) {
    const key = JSON.stringify([row.courseCode, row.year, row.semesterName]);
    let group = groups.get(key);
    if (!group) {
      group = { code: row.courseCode, year: row.year, semester: row.semesterName, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.year !== b.year) return a.year - b.year;
    const aSem = a.semester ?? "";
    const bSem = b.semester ?? "";
    return aSem < bSem ? -1 : aSem > bSem ? 1 : 0;
  });

  return sortedGroups.map((group) => {
    const total = group.rows.reduce((sum, r) => sum + (r.total ?? 0), 0);
    const candidates = total;
    const sortedRows = [...group.rows].sort((a, b) =>
      a.grade < b.grade ? -1 : a.grade > b.grade ? 1 : 0,
    );
    const grades: Record<string, { count: number | "masked"; percent: number | null }> = {};
    for (const r of sortedRows) {
      grades[r.grade] = {
        count: r.total !== null ? r.total : "masked",
        percent: r.total !== null && candidates > 0 ? round1((100 * r.total) / candidates) : null,
      };
    }
    return {
      course_code: group.code,
      year: group.year,
      semester: group.semester,
      candidates,
      grades,
    };
  });
}
