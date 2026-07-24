/**
 * NEW tools (no Python original): `search_study_programs` and
 * `get_study_plan`, built on ntnu-api 0.3's `client.programs`.
 *
 * Together with the course tools these close the loop from "I'm starting
 * program X" to a concrete semester: find the program, get its plan
 * (course codes per semester, mandatory/elective, specializations), then
 * feed the codes to timetable/conflict/exam tools.
 */
import type { PlanDirection, StudyPlan } from "ntnu-api";
import { NTNUAPIError } from "ntnu-api";
import type { ToolDeps } from "./deps.js";
import { UpstreamError } from "./deps.js";
import { cachedProgramCatalog, cachedStudyPlan } from "./upstream.js";

/** Max programs returned per `search_study_programs` call. */
export const PROGRAM_RESULT_LIMIT = 50;

/**
 * Search NTNU's study-program catalog (~400 programs) by free text, level,
 * and/or city. Returns program codes — the input for get_study_plan.
 */
export async function searchStudyPrograms(
  deps: ToolDeps,
  args: { query?: string | null; level?: string | null; city?: string | null },
): Promise<object> {
  let programs: Awaited<ReturnType<typeof cachedProgramCatalog>>;
  try {
    programs = await cachedProgramCatalog(deps);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`NTNU program catalog request failed: ${exc.message}`);
    }
    throw exc;
  }

  const query = args.query?.trim().toLowerCase() || null;
  const level = args.level?.trim().toLowerCase() || null;
  const city = args.city?.trim().toLowerCase() || null;

  const matches = programs.filter((p) => {
    if (query) {
      const haystack = `${p.code} ${p.name} ${p.keywords ?? ""} ${p.description ?? ""} ${
        p.fieldOfEducationName ?? ""
      }`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (level && !(p.studyLevel ?? "").toLowerCase().includes(level)) return false;
    if (city && !p.cities.some((c) => c.toLowerCase().includes(city))) return false;
    return true;
  });

  const shown = matches.slice(0, PROGRAM_RESULT_LIMIT);
  const shaped: Record<string, unknown> = {
    num_found: matches.length,
    showing: shown.length,
    programs: shown.map((p) => ({
      code: p.code,
      name: p.name,
      level: p.studyLevel,
      cities: p.cities,
      department: p.departmentName,
      taught_in_english: p.taughtInEnglish,
      field_of_education: p.fieldOfEducationName,
    })),
  };
  if (matches.length > shown.length) {
    shaped.note = `Showing first ${PROGRAM_RESULT_LIMIT} of ${matches.length} matches; narrow the query.`;
  }
  return shaped;
}

interface ShapedCourse {
  code: string;
  name: string | null;
  credits: number | null;
  /** Mandatory/elective marker code, e.g. "O" = obligatorisk. */
  choice: string | null;
  version?: string;
  non_course_requirement?: true;
}

function shapeDirection(direction: PlanDirection): {
  course_groups: Array<{ name: string | null; courses: ShapedCourse[] }>;
  choice_points: Array<{
    name: string | null;
    deadline: string | null;
    options: Array<
      { code: string | null; name: string | null } & ReturnType<typeof shapeDirection>
    >;
  }>;
} {
  return {
    course_groups: direction.courseGroups.map((g) => ({
      name: g.name,
      courses: g.courses.map((c) => {
        const shaped: ShapedCourse = {
          code: c.code,
          name: c.name,
          credits: c.credits,
          choice: c.studyChoice?.code ?? null,
        };
        if (c.version !== null && c.version !== "1") {
          shaped.version = c.version;
        }
        if (c.planElement) {
          shaped.non_course_requirement = true;
        }
        return shaped;
      }),
    })),
    choice_points: direction.waypoints.map((w) => ({
      name: w.name,
      deadline: w.deadlineDate,
      options: w.directions.map((d) => ({
        code: d.code,
        name: d.name,
        ...shapeDirection(d),
      })),
    })),
  };
}

function shapePlan(plan: StudyPlan): object {
  return {
    program_code: plan.code,
    program_name: plan.name,
    cohort_year: plan.year,
    start_term: plan.startTerm,
    periods: plan.periods.map((p) => ({
      // Period N = semester N of the program (1 = first semester).
      period: p.periodNumber,
      ...shapeDirection(p.direction),
    })),
    note:
      "Each period is one semester in program order. 'choice' marks " +
      "mandatory (O) vs elective courses; choice_points list alternative " +
      "specializations with their own course groups. Recent cohorts only " +
      "have their published semesters so far.",
  };
}

/**
 * The study plan for a program and cohort intake year: which courses
 * (with credits and mandatory/elective markers) in which semester, and
 * the specialization choice points. Cohort year defaults to the current
 * year, falling back one year if that cohort's plan is not published yet.
 */
export async function getStudyPlan(
  deps: ToolDeps,
  args: { program_code: string; cohort_year?: number | null },
): Promise<object> {
  const code = args.program_code.trim().toUpperCase();
  const requested = args.cohort_year ?? null;
  const now = (deps.now?.() ?? new Date()).getFullYear();

  let plan: StudyPlan | null;
  let year = requested ?? now;
  try {
    plan = await cachedStudyPlan(deps, code, year);
    if (plan === null && requested === null) {
      // Before a new cohort's plan is published, the current freshmen
      // cohort (last year's intake) is the most useful answer.
      year = now - 1;
      plan = await cachedStudyPlan(deps, code, year);
    }
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`NTNU study-plan request failed: ${exc.message}`);
    }
    throw exc;
  }

  if (plan === null) {
    return {
      program_code: code,
      cohort_year: requested ?? now,
      note:
        "No study plan found — unknown program code, or no plan published " +
        "for that cohort year. Use search_study_programs to verify the code; " +
        "plans exist for intake years from 2007 onward.",
    };
  }
  return shapePlan(plan);
}
