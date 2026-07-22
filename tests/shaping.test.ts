import {
  type GradeRow,
  parseGradeRow,
  parseScheduleActivity,
  parseTimetableEntry,
  type Room,
} from "ntnu-api";
import { describe, expect, it } from "vitest";
import {
  DAY_NAMES,
  formatRooms,
  gradeTables,
  osloDateTime,
  osloTime,
  shapeActivity,
  shapeSlot,
} from "../src/shaping.js";
import { loadFixture } from "./helpers.js";

const EPOCH_ANCHOR_MS = 1768202100000; // 07:15 UTC = 08:15 Europe/Oslo (2026-01-12)

describe("osloDateTime / osloTime", () => {
  it("renders the anchor epoch as the documented Oslo local time", () => {
    const d = new Date(EPOCH_ANCHOR_MS);
    expect(osloDateTime(d)).toBe("2026-01-12 08:15");
    expect(osloTime(d)).toBe("08:15");
  });

  it("osloTime renders bare HH:mm, e.g. for a noon-ish instant", () => {
    // 11:00 UTC in January (winter, UTC+1) => 12:00 Oslo
    const d = new Date("2026-01-12T11:00:00.000Z");
    expect(osloTime(d)).toBe("12:00");
  });
});

describe("formatRooms", () => {
  it("formats a room with a building as '<room> (<building>)'", () => {
    const rooms: Room[] = [{ id: "1", room: "R52", building: "Realfagbygget", url: null }];
    expect(formatRooms(rooms)).toEqual(["R52 (Realfagbygget)"]);
  });

  it("formats a room without a building as the bare room string", () => {
    const rooms: Room[] = [{ id: "1", room: "R52", building: null, url: null }];
    expect(formatRooms(rooms)).toEqual(["R52"]);
  });

  it("skips entries without a room identifier", () => {
    const rooms: Room[] = [
      { id: "1", room: null, building: "Realfagbygget", url: null },
      { id: "2", room: "R51", building: null, url: null },
    ];
    expect(formatRooms(rooms)).toEqual(["R51"]);
  });

  it("returns an empty list for no rooms", () => {
    expect(formatRooms([])).toEqual([]);
  });
});

describe("shapeActivity", () => {
  it("shapes start/end/title/type/rooms from a schedule activity", () => {
    const activity = {
      courseCode: "TDT4100",
      courseName: { nob: null, nno: null, eng: null },
      acronym: null,
      activityCode: null,
      term: null,
      termNumber: null,
      name: "Forelesning",
      title: null,
      summary: null,
      status: null,
      tpId: null,
      start: new Date(EPOCH_ANCHOR_MS),
      end: new Date(EPOCH_ANCHOR_MS + 45 * 60 * 1000),
      week: 2,
      rooms: [{ id: "1", room: "R52", building: "Realfagbygget", url: null }],
      staff: [],
      studyProgramKeys: [],
    };
    const shaped = shapeActivity(activity);
    expect(shaped.start).toBe("2026-01-12 08:15");
    expect(shaped.end).toBe("09:00");
    // title falls back to name when title is absent
    expect(shaped.title).toBe("Forelesning");
    expect(shaped.type).toBe("Forelesning");
    expect(shaped.rooms).toEqual(["R52 (Realfagbygget)"]);
  });

  it("prefers title/summary over name when present", () => {
    const activity = {
      courseCode: "TDT4100",
      courseName: { nob: null, nno: null, eng: null },
      acronym: null,
      activityCode: null,
      term: null,
      termNumber: null,
      name: "Forelesning",
      title: "Lecture 1",
      summary: "Lecture",
      status: null,
      tpId: null,
      start: new Date(EPOCH_ANCHOR_MS),
      end: new Date(EPOCH_ANCHOR_MS),
      week: null,
      rooms: [],
      staff: [],
      studyProgramKeys: [],
    };
    const shaped = shapeActivity(activity);
    expect(shaped.title).toBe("Lecture 1");
    expect(shaped.type).toBe("Lecture");
  });

  it("shapes and sorts the schedules fixture with an Oslo start match", () => {
    const raw = loadFixture("schedules") as { schedules: unknown[] };
    const activities = raw.schedules.map(parseScheduleActivity);
    const shaped = activities
      .map(shapeActivity)
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    expect(shaped.some((a) => a.start === "2026-01-12 08:15")).toBe(true);
    expect(shaped.some((a) => a.rooms.some((r) => r === "R52 (Realfagbygget)"))).toBe(true);
  });
});

describe("shapeSlot", () => {
  it("resolves the day name via DAY_NAMES and joins weeks with commas", () => {
    const entry = parseTimetableEntry({
      courseCode: "TDT4100",
      courseName: {},
      dayNum: 1,
      from: "08:15",
      to: "10:00",
      weeks: ["2-13", "15-18"],
      name: "Forelesning",
      title: null,
      rooms: [],
    });
    const slot = shapeSlot(entry);
    expect(slot.day).toBe("Monday");
    expect(slot.start).toBe("08:15");
    expect(slot.end).toBe("10:00");
    expect(slot.weeks).toBe("2-13,15-18");
    expect(slot.title).toBe("Forelesning");
  });

  it("falls back to String(dayNumber) for an unmapped day", () => {
    const entry = parseTimetableEntry({
      courseCode: "TDT4100",
      courseName: {},
      dayNum: 9,
      from: "08:15",
      to: "10:00",
      weeks: [],
      name: null,
      title: null,
      rooms: [],
    });
    expect(shapeSlot(entry).day).toBe("9");
  });

  it("matches DAY_NAMES 1..7 Monday..Sunday", () => {
    expect(DAY_NAMES).toEqual({
      1: "Monday",
      2: "Tuesday",
      3: "Wednesday",
      4: "Thursday",
      5: "Friday",
      6: "Saturday",
      7: "Sunday",
    });
  });

  it("shapes the timetable fixture's first sorted slot as Monday with the documented weeks", () => {
    const raw = loadFixture("timetable") as { summarized: unknown[] };
    const entries = raw.summarized.map(parseTimetableEntry);
    const sorted = [...entries].sort((a, b) =>
      a.dayNumber !== b.dayNumber ? a.dayNumber - b.dayNumber : a.startTime < b.startTime ? -1 : 1,
    );
    const first = shapeSlot(sorted[0]!);
    expect(first.day).toBe("Monday");
    expect(first.weeks).toBe("2-13,15-18");
  });
});

describe("gradeTables", () => {
  function row(overrides: Partial<GradeRow>): GradeRow {
    return {
      institutionCode: "1150",
      institutionName: null,
      courseCode: "TDT4100-1",
      year: 2023,
      semester: 1,
      semesterName: "Vår",
      grade: "A",
      total: 0,
      women: null,
      men: null,
      ...overrides,
    };
  }

  it("groups by (course_code, year, semester), sorts groups, and sorts grades within a group", () => {
    const rows: GradeRow[] = [
      row({ courseCode: "TDT4100-1", year: 2023, semesterName: "Vår", grade: "F", total: 10 }),
      row({ courseCode: "TDT4100-1", year: 2023, semesterName: "Vår", grade: "A", total: 90 }),
      row({ courseCode: "TDT4100-2", year: 2022, semesterName: null, grade: "A", total: 5 }),
      row({ courseCode: "TDT4100-1", year: 2022, semesterName: "Høst", grade: "A", total: 3 }),
    ];
    const tables = gradeTables(rows);
    // sorted by (code, year, semester ?? "")
    expect(tables.map((t) => [t.course_code, t.year, t.semester])).toEqual([
      ["TDT4100-1", 2022, "Høst"],
      ["TDT4100-1", 2023, "Vår"],
      ["TDT4100-2", 2022, null],
    ]);
    // grades within the Vår 2023 group are sorted by grade letter
    expect(Object.keys(tables[1]?.grades ?? {})).toEqual(["A", "F"]);
  });

  it("masks a row whose total is null and gives it a null percent", () => {
    const rows: GradeRow[] = [row({ grade: "A", total: 112 }), row({ grade: "B", total: null })];
    const table = gradeTables(rows)[0]!;
    expect(table.candidates).toBe(112);
    expect(table.grades.B).toEqual({ count: "masked", percent: null });
    expect(table.grades.A?.count).toBe(112);
    expect(table.grades.A?.percent).toBe(100);
  });

  it("returns null percent (not NaN) when candidates is 0", () => {
    const rows: GradeRow[] = [row({ grade: "A", total: null }), row({ grade: "B", total: null })];
    const table = gradeTables(rows)[0]!;
    expect(table.candidates).toBe(0);
    expect(table.grades.A).toEqual({ count: "masked", percent: null });
  });

  it("matches the grades fixture: Vår table has A count 112 and percents sum to ~100", () => {
    const raw = loadFixture("grades") as unknown[];
    const rows = raw.map(parseGradeRow);
    const tables = gradeTables(rows);
    const spring = tables.find((t) => t.semester === "Vår");
    expect(spring).toBeDefined();
    expect(spring?.course_code).toBe("TDT4100-1");
    expect(spring?.grades.A?.count).toBe(112);
    expect(spring?.candidates).toBeGreaterThan(0);
    const pctSum = Object.values(spring?.grades ?? {}).reduce(
      (sum, g) => sum + (g.percent ?? 0),
      0,
    );
    expect(pctSum).toBeGreaterThanOrEqual(99.0);
    expect(pctSum).toBeLessThanOrEqual(101.0);
  });

  it("propagates a masked count from the raw fixture row (e.g. '<5')", () => {
    const raw = loadFixture("grades") as Array<Record<string, unknown>>;
    const rows = raw.slice(0, 2).map((r) => ({ ...r }));
    rows[0]!["Antall kandidater totalt"] = "<5";
    const parsed = rows.map(parseGradeRow);
    const table = gradeTables(parsed)[0]!;
    const counts = Object.values(table.grades).map((g) => g.count);
    expect(counts).toContain("masked");
  });

  it("returns an empty array for no rows", () => {
    expect(gradeTables([])).toEqual([]);
  });
});
