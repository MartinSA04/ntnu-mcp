/**
 * Tests for the two course-page tools (`get_course_info`, `get_exam_info`).
 *
 * The HTML fixtures are complete course pages captured live on 2026-07-23
 * (shared with ntnu-api's own test suite):
 * - `course_page_nb.html` — TDT4100 2025/2026, Norwegian; published exam
 *   dates/times/rooms.
 * - `course_page_en.html` — TDT4100 2025/2026, English (ntnu.edu).
 * - `course_page_multipart.html` — EXPH0300 2025/2026, multi-part exams.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCourseInfo, getExamInfo } from "../src/details.js";
import { makeDeps, routeFetch } from "./helpers.js";

function htmlResponse(name: string): Response {
  const path = fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
  return new Response(readFileSync(path, "utf-8"), {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

const NOT_FOUND_PAGE = new Response("<html><body>Fant ikke emnesiden</body></html>", {
  status: 200,
  headers: { "content-type": "text/html" },
});

describe("get_course_info", () => {
  it("shapes the English page with facts, prose, and study programs", async () => {
    const { fetch, calls } = routeFetch([
      { match: "ntnu.edu/studies/courses/TDT4100", respond: () => htmlResponse("course_page_en") },
    ]);
    const deps = makeDeps(fetch);

    const info = (await getCourseInfo(deps, { course_code: "tdt4100", year: 2025 })) as Record<
      string,
      unknown
    >;

    // English page is the default.
    expect(calls[0]?.url).toBe("https://www.ntnu.edu/studies/courses/TDT4100/2025");
    expect(info.course_code).toBe("TDT4100");
    expect(info.course_name).toBe("Object-Oriented Programming");
    expect(info.study_year).toBe(2025);
    expect(info.credits).toBe(7.5);
    expect(info.campus).toBe("Trondheim");
    expect(info.language_of_instruction).toBe("Norwegian");
    expect(info.assessment).toBe("Written exam");
    expect(info.grading).toBe("Letter grades");
    expect(info.content).toMatch(/^Basic algorithms and data structures/);
    expect(info.mandatory_activities).toEqual(["Assignments"]);
    expect(info.department).toBe("Department of Computer Science");
    // The English page carries English program names.
    expect(info.study_programs).toContainEqual({ code: "MTDT", name: "Computer Science" });
    expect(info.credit_reductions).toContainEqual({
      course_code: "TDT4102",
      reduction: "3.7 sp",
      from: "Autumn 2008",
    });
    expect(info.contacts).toEqual([
      { role: "Course coordinator", persons: ["Dag Olav Kjellemo"] },
      { role: "Lecturers", persons: ["Børge Haugset"] },
    ]);
    expect(info.years_offered).toBe("2007-2026");
    // Exam logistics live in the other tool; only the pointer is here.
    expect(info.note).toContain("get_exam_info");
    expect(info).not.toHaveProperty("exams");
  });

  it("fetches the Norwegian page when language is 'nb'", async () => {
    const { fetch, calls } = routeFetch([
      { match: "ntnu.no/studier/emner/TDT4100", respond: () => htmlResponse("course_page_nb") },
    ]);
    const deps = makeDeps(fetch);

    const info = (await getCourseInfo(deps, {
      course_code: "TDT4100",
      year: 2025,
      language: "nb",
    })) as Record<string, unknown>;

    expect(calls[0]?.url).toBe("https://www.ntnu.no/studier/emner/TDT4100/2025");
    expect(info.course_name).toBe("Objektorientert programmering");
    expect(info.content).toMatch(/^Grunnleggende algoritmer/);
  });

  it("omits the year path segment when year is not given", async () => {
    const { fetch, calls } = routeFetch([
      { match: "ntnu.edu", respond: () => htmlResponse("course_page_en") },
    ]);
    const deps = makeDeps(fetch);
    await getCourseInfo(deps, { course_code: "TDT4100" });
    expect(calls[0]?.url).toBe("https://www.ntnu.edu/studies/courses/TDT4100");
  });

  it("returns a note (not an error) for an unknown course", async () => {
    const { fetch } = routeFetch([{ match: "ntnu.edu", respond: () => NOT_FOUND_PAGE.clone() }]);
    const deps = makeDeps(fetch);

    const info = (await getCourseInfo(deps, { course_code: "XXX9999", year: 2025 })) as Record<
      string,
      unknown
    >;
    expect(info.course_code).toBe("XXX9999");
    expect(info.note).toContain("search_courses");
    expect(info).not.toHaveProperty("credits");
  });

  it("caches the page: two calls, one upstream fetch", async () => {
    const { fetch, calls } = routeFetch([
      { match: "ntnu.edu", respond: () => htmlResponse("course_page_en") },
    ]);
    const deps = makeDeps(fetch);

    await getCourseInfo(deps, { course_code: "TDT4100", year: 2025 });
    await getCourseInfo(deps, { course_code: "TDT4100", year: 2025 });
    expect(calls.length).toBe(1);
  });
});

describe("get_exam_info", () => {
  it("returns compact exam logistics for several courses in one call", async () => {
    const { fetch, calls } = routeFetch([
      { match: "/TDT4100", respond: () => htmlResponse("course_page_en") },
      { match: "/EXPH0300", respond: () => htmlResponse("course_page_multipart") },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getExamInfo(deps, {
      course_codes: ["tdt4100", "EXPH0300", "TDT4100"], // dupe collapses
      year: 2025,
    })) as { year: number; courses: Array<Record<string, unknown>> };

    expect(calls.length).toBe(2);
    expect(result.year).toBe(2025);
    expect(result.courses.length).toBe(2);

    const tdt = result.courses[0] as {
      exams: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    expect(tdt.course_code).toBe("TDT4100");
    expect(tdt.assessment).toBe("Written exam");
    const ordinary = tdt.exams.find((e) => e.occasion === "Ordinary examination");
    expect(ordinary).toMatchObject({
      season: "Spring 2026",
      form: "Written exam",
      weighting: "100/100",
      date: "2026-05-18",
      start_time: "09:00",
      duration: "4 hours",
      aids: "Code C",
      system: "Inspera Assessment",
    });
    expect(ordinary?.aids_meaning).toMatch(/^Specified written or handwritten/);
    const rooms = (ordinary?.rooms ?? []) as string[];
    expect(rooms.length).toBe(11);
    expect(rooms).toContain("SL311 brun sone (Sluppenvegen 14), 82 candidates");

    // Multi-part course: home-exam part keeps raw handout text as date.
    const exph = result.courses[1] as { exams: Array<Record<string, unknown>> };
    expect(exph.exams.length).toBe(6);
    const home = exph.exams[1];
    expect(home?.form).toBe("Hjemmeeksamen");
    expect(home?.occasion).toBe("Ordinær eksamen"); // carried forward
    expect(home?.date).toBe("Utlevering 07.11.2025");
    expect(home?.duration).toBe("4 uker");
  });

  it("mixes found and not-found courses without failing the call", async () => {
    const { fetch } = routeFetch([
      { match: "/TDT4100", respond: () => htmlResponse("course_page_en") },
      { match: "/XXX9999", respond: () => NOT_FOUND_PAGE.clone() },
    ]);
    const deps = makeDeps(fetch);

    const result = (await getExamInfo(deps, {
      course_codes: ["TDT4100", "XXX9999"],
      year: 2025,
    })) as { courses: Array<Record<string, unknown>> };

    expect(result.courses.length).toBe(2);
    expect(result.courses[0]).toHaveProperty("exams");
    expect(result.courses[1]?.note).toContain("search_courses");
  });

  it("caps the number of courses per call and says so", async () => {
    const { fetch, calls } = routeFetch([
      { match: "ntnu.edu", respond: () => htmlResponse("course_page_en") },
    ]);
    const deps = makeDeps(fetch);

    const codes = Array.from({ length: 12 }, (_, i) => `AAA${1000 + i}`);
    const result = (await getExamInfo(deps, { course_codes: codes, year: 2025 })) as {
      courses: unknown[];
      note?: string;
    };

    expect(result.courses.length).toBe(10);
    expect(calls.length).toBe(10);
    expect(result.note).toContain("first 10 of 12");
  });
});
