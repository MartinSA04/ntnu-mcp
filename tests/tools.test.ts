/**
 * Tests for the six ported MCP tools (`src/tools.ts`).
 *
 * Ports every case from `ntnu-api`'s `tests/test_mcp.py` except
 * `test_all_tools_are_registered`, which moves to `tests/server.test.ts`
 * (registration is a server-layer concern, not a tool-shaping one).
 */

import { describe, expect, it } from "vitest";
import { UpstreamError } from "../src/deps.js";
import {
  getCourseSchedule,
  getCourseVersions,
  getGradeDistribution,
  getSemesters,
  getWeeklyTimetable,
  searchCourses,
} from "../src/tools.js";
import { jsonResponse, loadFixture, makeDeps, routeFetch } from "./helpers.js";

const SEARCH_URL = "https://www.ntnu.no/web/studier/emnesok";
const DETAILS_URL = "https://www.ntnu.no/web/studier/emner";
const DBH_TABLE_DATA_URL = "https://dbh.hkdir.no/api/Tabeller/hentJSONTabellData";
const TP_SEMESTERS_URL = "https://tp.educloud.no/ntnu/ws/services/semesters.php";

describe("search_courses", () => {
  it("shapes and caches results", async () => {
    const { fetch, calls } = routeFetch([
      { match: SEARCH_URL, respond: () => jsonResponse(loadFixture("catalog_page")) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await searchCourses(deps, {
      year: 2026,
      query: "objektorientert",
    })) as {
      num_found: number;
      courses: Array<{
        code: string;
        name: string;
        campus: string;
        exams: Array<{ season: string }>;
      }>;
    };

    expect(result.num_found).toBe(4767);
    const tdt = result.courses.find((c) => c.code === "TDT4100");
    expect(tdt?.name).toBe("Objektorientert programmering");
    expect(tdt?.campus).toBe("Trondheim");
    const examCourse = result.courses.find((c) => c.exams.length > 0);
    expect(examCourse?.exams[0]?.season).toBe("AUTUMN");

    // Second identical call is served from cache — no new HTTP request.
    await searchCourses(deps, { year: 2026, query: "objektorientert" });
    expect(calls.filter((c) => c.url.includes(SEARCH_URL)).length).toBe(1);
  });

  it("maps an upstream 500 to UpstreamError with the catalog prefix", async () => {
    const { fetch } = routeFetch([
      { match: SEARCH_URL, respond: () => new Response("", { status: 500 }) },
    ]);
    const deps = makeDeps(fetch);

    await expect(searchCourses(deps, { year: 2026, query: "x" })).rejects.toThrow(UpstreamError);
    await expect(searchCourses(deps, { year: 2026, query: "x" })).rejects.toThrow(
      /catalog request failed/,
    );
  });
});

describe("get_course_schedule", () => {
  it("uses the English course name and Europe/Oslo local time", async () => {
    const { fetch } = routeFetch([
      { match: DETAILS_URL, respond: () => jsonResponse(loadFixture("schedules")) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getCourseSchedule(deps, { course_code: "tdt4100", year: 2026 })) as {
      course_name: string;
      activities: Array<{ start: string; rooms: string[] }>;
    };

    expect(result.course_name).toBe("Object-Oriented Programming");
    const starts = result.activities.map((a) => a.start);
    expect(starts).toEqual([...starts].sort());
    // 1768202100000 ms = 07:15 UTC = 08:15 Europe/Oslo
    expect(starts).toContain("2026-01-12 08:15");
    expect(result.activities.some((a) => a.rooms.includes("R52 (Realfagbygget)"))).toBe(true);
  });

  it("returns guidance instead of an error for an empty schedule", async () => {
    const { fetch } = routeFetch([
      { match: DETAILS_URL, respond: () => jsonResponse({ schedules: [] }) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getCourseSchedule(deps, { course_code: "XXX9999", year: 2026 })) as {
      activities: unknown[];
      note: string;
    };

    expect(result.activities).toEqual([]);
    expect(result.note).toContain("search_courses");
  });
});

describe("get_weekly_timetable", () => {
  it("shapes days and weeks", async () => {
    const { fetch } = routeFetch([
      { match: DETAILS_URL, respond: () => jsonResponse(loadFixture("timetable")) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getWeeklyTimetable(deps, { course_code: "TDT4100", year: 2026 })) as {
      slots: Array<{ day: string; weeks: string }>;
    };

    expect(result.slots[0]?.day).toBe("Monday");
    expect(result.slots[0]?.weeks).toBe("2-13,15-18");
  });
});

describe("get_grade_distribution", () => {
  it("collapses rows into per-term distribution tables", async () => {
    const { fetch } = routeFetch([
      { match: DBH_TABLE_DATA_URL, respond: () => jsonResponse(loadFixture("grades")) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getGradeDistribution(deps, {
      course_code: "TDT4100",
      years: [2023],
    })) as {
      distributions: Array<{
        course_code: string;
        semester: string | null;
        candidates: number;
        grades: Record<string, { count: number | "masked"; percent: number | null }>;
      }>;
    };

    const spring = result.distributions.find((d) => d.semester === "Vår");
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

  it("keeps masked grade counts intact through shaping", async () => {
    const rows = (loadFixture("grades") as Array<Record<string, unknown>>).slice(0, 2);
    rows[0]!["Antall kandidater totalt"] = "<5";
    const { fetch } = routeFetch([
      { match: DBH_TABLE_DATA_URL, respond: () => jsonResponse(rows) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getGradeDistribution(deps, { course_code: "TDT4100" })) as {
      distributions: Array<{ grades: Record<string, { count: number | "masked" }> }>;
    };

    const grades = result.distributions[0]?.grades ?? {};
    expect(Object.values(grades).some((g) => g.count === "masked")).toBe(true);
  });

  it("returns guidance naming get_course_versions on empty (204) results", async () => {
    const { fetch } = routeFetch([
      { match: DBH_TABLE_DATA_URL, respond: () => new Response(null, { status: 204 }) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getGradeDistribution(deps, { course_code: "XXX9999" })) as {
      distributions: unknown[];
      note: string;
    };

    expect(result.distributions).toEqual([]);
    expect(result.note).toContain("get_course_versions");
  });
});

describe("get_course_versions", () => {
  it("returns the DBH-versioned codes", async () => {
    const { fetch } = routeFetch([
      {
        match: DBH_TABLE_DATA_URL,
        respond: () => jsonResponse([{ Emnekode: "TDT4100-1" }]),
      },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getCourseVersions(deps, { course_code: "TDT4100" })) as {
      versions: string[];
    };

    expect(result.versions).toEqual(["TDT4100-1"]);
  });
});

describe("get_semesters", () => {
  it("marks the current semester and caches across two upstream calls", async () => {
    const { fetch, calls } = routeFetch([
      { match: TP_SEMESTERS_URL, respond: () => jsonResponse(loadFixture("semesters")) },
    ]);
    const deps = makeDeps(fetch, () => new Date("2026-07-22"));

    const result = (await getSemesters(deps)) as {
      current_semester_id: string;
      semesters: Array<{ id: string; name: string; teaching_weeks: number[] }>;
    };

    expect(result.current_semester_id).toBe("26h");
    const current = result.semesters.find((s) => s.id === "26h");
    expect(current?.name).toBe("2026 Autumn");
    expect(current?.teaching_weeks[0]).toBe(34);

    await getSemesters(deps);
    // all() + current() on the first call only — the second call is served from cache.
    expect(calls.filter((c) => c.url.includes(TP_SEMESTERS_URL)).length).toBe(2);
  });
});
