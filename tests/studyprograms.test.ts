/**
 * Tests for the study-program tools (`search_study_programs`,
 * `get_study_plan`). Fixtures shared with ntnu-api's suite (captured
 * 2026-07-24): a six-program `allStudies` subset, the full MTDT
 * 2022-cohort plan, and the studieplan page HTML (source of the planner
 * portlet's instance id, which ntnu-api scrapes on first use).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getStudyPlan, searchStudyPrograms } from "../src/studyprograms.js";
import { jsonResponse, loadFixture, makeDeps, routeFetch } from "./helpers.js";

function htmlResponse(name: string): Response {
  const path = fileURLToPath(new URL(`./fixtures/${name}.html`, import.meta.url));
  return new Response(readFileSync(path, "utf-8"), {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

/** Routes for the two-step study-plan flow: JSON resource first (more specific match). */
function studyPlanRoutes(planResponder: () => Response) {
  return [
    { match: "p_p_resource_id=studyplan", respond: planResponder },
    { match: "studieplan", respond: () => htmlResponse("studyplan_page") },
  ];
}

describe("search_study_programs", () => {
  it("filters the catalog by query, level, and city", async () => {
    const { fetch, calls } = routeFetch([
      { match: "allStudies", respond: () => jsonResponse(loadFixture("study_programs")) },
    ]);
    const deps = makeDeps(fetch);

    const result = (await searchStudyPrograms(deps, {
      query: "datateknologi",
      level: "master",
      city: "trondheim",
    })) as { num_found: number; programs: Array<Record<string, unknown>> };

    expect(calls.length).toBe(1);
    expect(result.num_found).toBe(1);
    expect(result.programs[0]).toMatchObject({
      code: "MTDT",
      name: "Datateknologi",
      level: "Master 5 år",
      cities: ["Trondheim"],
      department: "Institutt for datateknologi og informatikk",
      taught_in_english: false,
    });
  });

  it("matches on keywords too, and caches the catalog across calls", async () => {
    const { fetch, calls } = routeFetch([
      { match: "allStudies", respond: () => jsonResponse(loadFixture("study_programs")) },
    ]);
    const deps = makeDeps(fetch);

    // "sivilingeniør" appears only in MTDT/MTKOM keywords, not their names.
    const byKeyword = (await searchStudyPrograms(deps, { query: "sivilingeniør" })) as {
      programs: Array<{ code: string }>;
    };
    expect(byKeyword.programs.map((p) => p.code).sort()).toContain("MTDT");

    await searchStudyPrograms(deps, { query: "informatikk" });
    expect(calls.length).toBe(1); // second call served from cache
  });

  it("returns everything (capped) with no filters", async () => {
    const { fetch } = routeFetch([
      { match: "allStudies", respond: () => jsonResponse(loadFixture("study_programs")) },
    ]);
    const deps = makeDeps(fetch);
    const result = (await searchStudyPrograms(deps, {})) as { num_found: number; showing: number };
    expect(result.num_found).toBe(6);
    expect(result.showing).toBe(6);
  });
});

describe("get_study_plan", () => {
  it("shapes periods, course groups, and specialization choice points", async () => {
    const { fetch } = routeFetch(studyPlanRoutes(() => jsonResponse(loadFixture("study_plan"))));
    const deps = makeDeps(fetch);

    const result = (await getStudyPlan(deps, {
      program_code: "mtdt",
      cohort_year: 2022,
    })) as {
      program_code: string;
      cohort_year: number;
      periods: Array<{
        period: number;
        course_groups: Array<{ name: string; courses: Array<Record<string, unknown>> }>;
        choice_points: Array<{ name: string; options: Array<Record<string, unknown>> }>;
      }>;
    };

    expect(result.program_code).toBe("MTDT");
    expect(result.cohort_year).toBe(2022);
    expect(result.periods.length).toBe(10);

    const period2 = result.periods.find((p) => p.period === 2);
    const courses = period2?.course_groups.flatMap((g) => g.courses) ?? [];
    expect(courses).toContainEqual({
      code: "TDT4100",
      name: "Objektorientert programmering",
      credits: 7.5,
      choice: "O",
    });

    const period7 = result.periods.find((p) => p.period === 7);
    const choicePoint = period7?.choice_points[0];
    expect(choicePoint?.name).toBe("Valg av studieretning");
    const optionNames = choicePoint?.options.map((o) => o.name) ?? [];
    expect(optionNames).toContain("Kunstig intelligens");
  });

  it("falls back one year when the current cohort's plan is unpublished", async () => {
    const notFound = {
      settings: {},
      studyplan: null,
      error: "Finner ikke MTDT 2026",
      publishedYears: [2025],
    };
    let planCalls = 0;
    const { fetch } = routeFetch(
      studyPlanRoutes(() => {
        planCalls += 1;
        return planCalls === 1 ? jsonResponse(notFound) : jsonResponse(loadFixture("study_plan"));
      }),
    );
    const deps = makeDeps(fetch, () => new Date("2026-07-24T12:00:00Z"));

    const result = (await getStudyPlan(deps, { program_code: "MTDT" })) as Record<string, unknown>;
    expect(planCalls).toBe(2);
    expect(result.program_code).toBe("MTDT");
    expect(result).toHaveProperty("periods");
  });

  it("returns a guidance note for unknown programs", async () => {
    const notFound = {
      settings: {},
      studyplan: null,
      error: "Finner ikke XXXX 2022",
      publishedYears: [2025],
    };
    const { fetch } = routeFetch(studyPlanRoutes(() => jsonResponse(notFound)));
    const deps = makeDeps(fetch);

    const result = (await getStudyPlan(deps, {
      program_code: "XXXX",
      cohort_year: 2022,
    })) as Record<string, unknown>;
    expect(result.note).toContain("search_study_programs");
    expect(result).not.toHaveProperty("periods");
  });

  it("caches plans: repeated calls fetch upstream once", async () => {
    let planCalls = 0;
    const { fetch } = routeFetch(
      studyPlanRoutes(() => {
        planCalls += 1;
        return jsonResponse(loadFixture("study_plan"));
      }),
    );
    const deps = makeDeps(fetch);

    await getStudyPlan(deps, { program_code: "MTDT", cohort_year: 2022 });
    await getStudyPlan(deps, { program_code: "MTDT", cohort_year: 2022 });
    expect(planCalls).toBe(1);
  });
});
