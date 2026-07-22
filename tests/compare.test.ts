import { describe, expect, it } from "vitest";
import { compareCourses } from "../src/compare.js";
import { jsonResponse, loadFixture, makeDeps, routeFetch } from "./helpers.js";

const SEARCH_URL = "https://www.ntnu.no/web/studier/emnesok";
const DETAILS_URL = "https://www.ntnu.no/web/studier/emner";
const DBH_URL = "https://dbh.hkdir.no/api/Tabeller/hentJSONTabellData";

function deps() {
  const { fetch, calls } = routeFetch([
    { match: SEARCH_URL, respond: () => jsonResponse(loadFixture("catalog_page")) },
    { match: DETAILS_URL, respond: () => jsonResponse(loadFixture("timetable")) },
    { match: DBH_URL, respond: () => jsonResponse(loadFixture("grades")) },
  ]);
  return { deps: makeDeps(fetch), calls };
}

describe("compareCourses", () => {
  it("shapes a known course with campus, exam dates, hours, and latest grades", async () => {
    const { deps: d } = deps();
    const result = (await compareCourses(d, {
      course_codes: ["tdt4100"],
      year: 2026,
    })) as {
      year: number;
      courses: Array<{
        code: string;
        name: string | null;
        campus: string | null;
        exam_dates: Array<{ date: string | null; season: string | null; continuation: boolean }>;
        weekly_teaching_hours: number | null;
        latest_grades: { course_code: string; year: number; semester: string | null } | null;
      }>;
      note: string;
    };

    expect(result.year).toBe(2026);
    const tdt = result.courses.find((c) => c.code === "TDT4100");
    expect(tdt).toBeDefined();
    expect(tdt?.campus).toBe("Trondheim");
    // catalog_page.json has no exams listed for TDT4100 itself
    expect(Array.isArray(tdt?.exam_dates)).toBe(true);
    // timetable.json: three TDT4100 slots, 08:15-12:00 (3.75h) + 08:15-18:00 (9.75h) + 12:15-14:00 (1.75h)
    expect(tdt?.weekly_teaching_hours).toBeCloseTo(15.25, 5);
    expect(tdt?.latest_grades).not.toBeNull();
    expect(tdt?.latest_grades?.course_code).toBe("TDT4100-1");
    expect(tdt?.latest_grades?.year).toBe(2023);
    expect(result.note).toContain("weekly_teaching_hours");
  });

  it("uses the AUTUMN exam season and campus from the search hit", async () => {
    const { deps: d } = deps();
    const result = (await compareCourses(d, {
      course_codes: ["TFE4130"],
      year: 2026,
    })) as {
      courses: Array<{ code: string; campus: string; exam_dates: Array<{ season: string }> }>;
    };
    const course = result.courses[0]!;
    expect(course.code).toBe("TFE4130");
    expect(course.campus).toBe("Trondheim");
    expect(course.exam_dates[0]?.season).toBe("AUTUMN");
  });

  it("dedupes course codes preserving order and trims/uppercases", async () => {
    const { deps: d, calls } = deps();
    const result = (await compareCourses(d, {
      course_codes: [" tdt4100 ", "TDT4100", "tfe4130"],
      year: 2026,
    })) as { courses: Array<{ code: string }> };
    expect(result.courses.map((c) => c.code)).toEqual(["TDT4100", "TFE4130"]);
    // one search + one timetable + one grades call per distinct code (2 codes)
    expect(calls.filter((c) => c.url.includes("emnesok")).length).toBe(2);
  });

  it("flags a course found in neither search nor timetable with a not-found note", async () => {
    const { fetch } = routeFetch([
      { match: SEARCH_URL, respond: () => jsonResponse(loadFixture("catalog_page")) },
      { match: DETAILS_URL, respond: () => jsonResponse({ summarized: [] }) },
      { match: DBH_URL, respond: () => new Response(null, { status: 204 }) },
    ]);
    const d = makeDeps(fetch);
    const result = (await compareCourses(d, {
      course_codes: ["XXX9999"],
      year: 2026,
    })) as { courses: Array<{ code: string; note?: string }> };
    expect(result.courses[0]?.note).toContain("not found");
    expect(result.courses[0]?.note).toContain("search_courses");
  });

  it("wraps upstream failures in an UpstreamError with the comparison prefix", async () => {
    const { fetch } = routeFetch([
      { match: SEARCH_URL, respond: () => new Response(null, { status: 500 }) },
    ]);
    const d = makeDeps(fetch);
    await expect(compareCourses(d, { course_codes: ["TDT4100"], year: 2026 })).rejects.toThrow(
      "NTNU comparison request failed",
    );
  });
});
