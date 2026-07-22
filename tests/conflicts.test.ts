import { describe, expect, it } from "vitest";
import {
  checkTimetableConflicts,
  type Slot,
  slotOverlaps,
  weeksToRanges,
} from "../src/conflicts.js";
import { jsonResponse, loadFixture, makeDeps, routeFetch } from "./helpers.js";

const SEARCH_URL = "https://www.ntnu.no/web/studier/emnesok";
const DETAILS_URL = "https://www.ntnu.no/web/studier/emner";

function slot(overrides: Partial<Slot>): Slot {
  return {
    code: "AAA0000",
    dayNumber: 1,
    startMin: 8 * 60,
    endMin: 10 * 60,
    weekSet: new Set([2, 3, 4]),
    label: "Lecture",
    ...overrides,
  };
}

describe("weeksToRanges", () => {
  it("round-trips a simple contiguous range", () => {
    expect(weeksToRanges([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])).toBe("2-13");
  });

  it("round-trips a disjoint range with a gap ('2-13,15')", () => {
    const weeks = [
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13, // 2-13
      15,
    ];
    expect(weeksToRanges(weeks)).toBe("2-13,15");
  });

  it("handles unsorted input and duplicates", () => {
    expect(weeksToRanges([5, 3, 4, 3])).toBe("3-5");
  });

  it("returns an empty string for an empty list", () => {
    expect(weeksToRanges([])).toBe("");
  });

  it("renders singleton weeks as bare numbers", () => {
    expect(weeksToRanges([2, 4, 6])).toBe("2,4,6");
  });
});

describe("slotOverlaps", () => {
  it("is true for same day, overlapping time, and intersecting weeks", () => {
    const a = slot({
      code: "A",
      dayNumber: 1,
      startMin: 8 * 60,
      endMin: 10 * 60,
      weekSet: new Set([2, 3]),
    });
    const b = slot({
      code: "B",
      dayNumber: 1,
      startMin: 9 * 60,
      endMin: 11 * 60,
      weekSet: new Set([3, 4]),
    });
    expect(slotOverlaps(a, b)).toBe(true);
  });

  it("is false when weeks are disjoint even if day/time overlap", () => {
    const a = slot({
      code: "A",
      dayNumber: 1,
      startMin: 8 * 60,
      endMin: 10 * 60,
      weekSet: new Set([2, 3]),
    });
    const b = slot({
      code: "B",
      dayNumber: 1,
      startMin: 9 * 60,
      endMin: 11 * 60,
      weekSet: new Set([5, 6]),
    });
    expect(slotOverlaps(a, b)).toBe(false);
  });

  it("is false on the same day when times are disjoint (touching endpoints don't conflict)", () => {
    const a = slot({
      code: "A",
      dayNumber: 2,
      startMin: 8 * 60,
      endMin: 10 * 60,
      weekSet: new Set([2, 3]),
    });
    const b = slot({
      code: "B",
      dayNumber: 2,
      startMin: 10 * 60,
      endMin: 12 * 60,
      weekSet: new Set([2, 3]),
    });
    expect(slotOverlaps(a, b)).toBe(false);
  });

  it("is false when days differ", () => {
    const a = slot({
      code: "A",
      dayNumber: 1,
      startMin: 8 * 60,
      endMin: 10 * 60,
      weekSet: new Set([2, 3]),
    });
    const b = slot({
      code: "B",
      dayNumber: 2,
      startMin: 8 * 60,
      endMin: 10 * 60,
      weekSet: new Set([2, 3]),
    });
    expect(slotOverlaps(a, b)).toBe(false);
  });
});

describe("checkTimetableConflicts", () => {
  it("detects an overlap between two different courses' timetables", async () => {
    const timetableByCourse: Record<string, unknown> = {
      AAA0001: {
        summarized: [
          {
            courseCode: "AAA0001",
            courseName: { nameNob: "Kurs A", nameNno: "Kurs A", nameEng: "Course A" },
            name: "Forelesning",
            title: "Forelesning 1",
            dayNum: 1,
            from: "08:15",
            to: "10:00",
            weeks: ["2-13"],
            rooms: [],
            studyProgramKeys: [],
            termnr: 1,
          },
        ],
      },
      BBB0002: {
        summarized: [
          {
            courseCode: "BBB0002",
            courseName: { nameNob: "Kurs B", nameNno: "Kurs B", nameEng: "Course B" },
            name: "Forelesning",
            title: "Forelesning 1",
            dayNum: 1,
            from: "09:00",
            to: "11:00",
            weeks: ["2-13"],
            rooms: [],
            studyProgramKeys: [],
            termnr: 1,
          },
        ],
      },
    };
    const { fetch } = routeFetch([
      {
        match: `${DETAILS_URL}?`,
        respond: (url) => {
          if (url.includes("AAA0001")) return jsonResponse(timetableByCourse.AAA0001);
          return jsonResponse(timetableByCourse.BBB0002);
        },
      },
      {
        match: SEARCH_URL,
        respond: () =>
          jsonResponse({
            courses: [],
            hasMoreResults: false,
            numFound: 0,
            pageNr: 1,
            pageSize: 500,
          }),
      },
    ]);
    const deps = makeDeps(fetch);
    const result = (await checkTimetableConflicts(deps, {
      course_codes: ["AAA0001", "BBB0002"],
      year: 2026,
    })) as {
      timetable_conflicts: Array<{
        courses: string[];
        day: string;
        weeks: string;
        a: { course: string; activity: string | null; time: string };
        b: { course: string; activity: string | null; time: string };
      }>;
      notes: string[];
    };
    expect(result.timetable_conflicts).toHaveLength(1);
    const conflict = result.timetable_conflicts[0]!;
    expect(conflict.courses).toEqual(["AAA0001", "BBB0002"]);
    expect(conflict.day).toBe("Monday");
    expect(conflict.weeks).toBe("2-13");
    expect(conflict.a.time).toBe("08:15-10:00");
    expect(conflict.b.time).toBe("09:00-11:00");
    expect(result.notes.some((n) => n.includes("Lab/exercise"))).toBe(true);
  });

  it("reports no conflict when weeks are disjoint", async () => {
    const makeEntry = (code: string, weeks: string[]) => ({
      summarized: [
        {
          courseCode: code,
          courseName: { nameNob: code, nameNno: code, nameEng: code },
          name: "Forelesning",
          title: "Forelesning 1",
          dayNum: 1,
          from: "08:15",
          to: "10:00",
          weeks,
          rooms: [],
          studyProgramKeys: [],
          termnr: 1,
        },
      ],
    });
    const { fetch } = routeFetch([
      {
        match: `${DETAILS_URL}?`,
        respond: (url) => {
          if (url.includes("AAA0001")) return jsonResponse(makeEntry("AAA0001", ["2-13"]));
          return jsonResponse(makeEntry("BBB0002", ["15-18"]));
        },
      },
      {
        match: SEARCH_URL,
        respond: () =>
          jsonResponse({
            courses: [],
            hasMoreResults: false,
            numFound: 0,
            pageNr: 1,
            pageSize: 500,
          }),
      },
    ]);
    const deps = makeDeps(fetch);
    const result = (await checkTimetableConflicts(deps, {
      course_codes: ["AAA0001", "BBB0002"],
      year: 2026,
    })) as { timetable_conflicts: unknown[] };
    expect(result.timetable_conflicts).toHaveLength(0);
  });

  it("reports no conflict when same-day times are disjoint", async () => {
    const makeEntry = (code: string, from: string, to: string) => ({
      summarized: [
        {
          courseCode: code,
          courseName: { nameNob: code, nameNno: code, nameEng: code },
          name: "Forelesning",
          title: "Forelesning 1",
          dayNum: 3,
          from,
          to,
          weeks: ["2-13"],
          rooms: [],
          studyProgramKeys: [],
          termnr: 1,
        },
      ],
    });
    const { fetch } = routeFetch([
      {
        match: `${DETAILS_URL}?`,
        respond: (url) => {
          if (url.includes("AAA0001")) return jsonResponse(makeEntry("AAA0001", "08:15", "10:00"));
          return jsonResponse(makeEntry("BBB0002", "10:00", "12:00"));
        },
      },
      {
        match: SEARCH_URL,
        respond: () =>
          jsonResponse({
            courses: [],
            hasMoreResults: false,
            numFound: 0,
            pageNr: 1,
            pageSize: 500,
          }),
      },
    ]);
    const deps = makeDeps(fetch);
    const result = (await checkTimetableConflicts(deps, {
      course_codes: ["AAA0001", "BBB0002"],
      year: 2026,
    })) as { timetable_conflicts: unknown[] };
    expect(result.timetable_conflicts).toHaveLength(0);
  });

  it("detects an exam-date collision from search results", async () => {
    const emptyTimetable = { summarized: [] };
    const catalogFor = (code: string, date: string) => ({
      courses: [
        {
          courseCode: code,
          courseName: code,
          courseUrl: null,
          courseVersion: "1",
          exam: [
            {
              date,
              continuation: false,
              season: "AUTUMN",
              submissionDate: null,
              withdrawalDate: null,
            },
          ],
          hasMultimedia: false,
          examOnly: false,
          location: "Trondheim",
        },
      ],
      hasMoreResults: false,
      numFound: 1,
      pageNr: 1,
      pageSize: 500,
    });
    const { fetch } = routeFetch([
      { match: DETAILS_URL, respond: () => jsonResponse(emptyTimetable) },
      {
        match: "emnesok",
        respond: (url) => {
          if (url.includes("AAA0001")) return jsonResponse(catalogFor("AAA0001", "2026-12-18"));
          return jsonResponse(catalogFor("BBB0002", "2026-12-18"));
        },
      },
    ]);
    const deps = makeDeps(fetch);
    const result = (await checkTimetableConflicts(deps, {
      course_codes: ["AAA0001", "BBB0002"],
      year: 2026,
    })) as { exam_conflicts: Array<{ date: string; courses: string[] }>; notes: string[] };
    expect(result.exam_conflicts).toHaveLength(1);
    expect(result.exam_conflicts[0]?.date).toBe("2026-12-18");
    expect(result.exam_conflicts[0]?.courses.sort()).toEqual(["AAA0001", "BBB0002"]);
    // no published timetable for either course
    expect(result.notes).toContain("No published timetable for AAA0001");
    expect(result.notes).toContain("No published timetable for BBB0002");
  });

  it("emits a per-course note when a course has no published timetable", async () => {
    const { fetch } = routeFetch([
      { match: DETAILS_URL, respond: () => jsonResponse({ summarized: [] }) },
      {
        match: SEARCH_URL,
        respond: () =>
          jsonResponse({
            courses: [],
            hasMoreResults: false,
            numFound: 0,
            pageNr: 1,
            pageSize: 500,
          }),
      },
    ]);
    const deps = makeDeps(fetch);
    const result = (await checkTimetableConflicts(deps, {
      course_codes: ["TDT4100", "TFE4130"],
      year: 2026,
    })) as { notes: string[] };
    expect(result.notes).toContain("No published timetable for TDT4100");
    expect(result.notes).toContain("No published timetable for TFE4130");
  });

  it("dedupes course codes and returns a note instead of throwing when fewer than 2 remain", async () => {
    const { fetch, calls } = routeFetch([
      { match: DETAILS_URL, respond: () => jsonResponse(loadFixture("timetable")) },
      { match: SEARCH_URL, respond: () => jsonResponse(loadFixture("catalog_page")) },
    ]);
    const deps = makeDeps(fetch);
    const result = (await checkTimetableConflicts(deps, {
      course_codes: [" tdt4100 ", "TDT4100"],
      year: 2026,
    })) as {
      courses_checked: string[];
      timetable_conflicts: unknown[];
      exam_conflicts: unknown[];
      notes: string[];
    };
    expect(result.courses_checked).toEqual(["TDT4100"]);
    expect(result.timetable_conflicts).toEqual([]);
    expect(result.exam_conflicts).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(0); // no upstream calls made when < 2 codes remain
  });

  it("wraps upstream failures in an UpstreamError with the timetable prefix", async () => {
    const { fetch } = routeFetch([
      { match: DETAILS_URL, respond: () => new Response(null, { status: 500 }) },
    ]);
    const deps = makeDeps(fetch);
    await expect(
      checkTimetableConflicts(deps, { course_codes: ["TDT4100", "TFE4130"], year: 2026 }),
    ).rejects.toThrow("NTNU timetable request failed");
  });
});
