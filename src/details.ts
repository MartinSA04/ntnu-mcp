/**
 * NEW tools (no Python original): `get_course_info` and `get_exam_info`,
 * built on ntnu-api 0.2's course-page scraper (`courses.details()`).
 *
 * One scraped page carries everything the JSON endpoints lack, but dumping
 * it verbatim would be a poor LLM tool, so the page is split into the two
 * questions students actually ask:
 *
 * - `get_course_info` — "tell me about this course": facts, prerequisites,
 *   descriptions, study programs, contacts. One course per call (the prose
 *   is long); exam logistics deliberately excluded.
 * - `get_exam_info` — "when/where are my exams, what can I bring": compact
 *   per-occasion logistics (date, start time, duration, aid code with its
 *   meaning, rooms) for *several* courses in one call, so a whole
 *   semester's exam plan is a single tool call.
 */
import type { CourseDetails, CourseExam } from "ntnu-api";
import { NTNUAPIError } from "ntnu-api";
import type { ToolDeps } from "./deps.js";
import { UpstreamError } from "./deps.js";
import { cachedDetails } from "./upstream.js";

/** Max courses per `get_exam_info` call (each course is one page fetch). */
export const EXAM_INFO_COURSE_LIMIT = 10;

const NOT_FOUND_NOTE =
  "Course page not found — unknown course code, or the course does not " +
  "exist for this study year. Use search_courses to verify the code.";

type Language = "nb" | "en";

async function fetchDetails(
  deps: ToolDeps,
  courseCode: string,
  year: number | null,
  language: Language,
): Promise<CourseDetails | null> {
  try {
    return await cachedDetails(deps, courseCode, year, language);
  } catch (exc) {
    if (exc instanceof NTNUAPIError) {
      throw new UpstreamError(`NTNU course page request failed: ${exc.message}`);
    }
    throw exc;
  }
}

/** `[2007, ..., 2026]` → `"2007-2026"`; sparse or empty lists stay explicit. */
function yearsOffered(years: number[]): string | null {
  if (years.length === 0) return null;
  const min = Math.min(...years);
  const max = Math.max(...years);
  // The selector is a contiguous run in practice; fall back to a list if not.
  return years.length === max - min + 1 ? `${min}-${max}` : years.join(", ");
}

/**
 * Everything about a course except exam logistics: facts (credits, level,
 * campus, language), prerequisites, mandatory activities, description
 * sections, credit reductions, the study programs the teaching is planned
 * for, contacts, and any alert notices. English by default; `language:
 * 'nb'` returns the Norwegian page's prose.
 */
export async function getCourseInfo(
  deps: ToolDeps,
  args: { course_code: string; year?: number | null; language?: Language | null },
): Promise<object> {
  const code = args.course_code.trim().toUpperCase();
  const year = args.year ?? null;
  const details = await fetchDetails(deps, code, year, args.language ?? "en");
  if (details === null) {
    return { course_code: code, year, note: NOT_FOUND_NOTE };
  }
  return {
    course_code: details.courseCode ?? code,
    course_name: details.courseName,
    study_year: details.studyYear,
    // Surfaced early: e.g. "Det tilbys ikke lenger undervisning i emnet."
    notices: details.notices,
    credits: details.credits,
    level: details.level,
    campus: details.location,
    language_of_instruction: details.teachingLanguage,
    teaching_start: details.teachingStart,
    teaching_duration: details.teachingDuration,
    assessment: details.assessmentScheme,
    grading: details.gradeRule,
    content: details.content,
    learning_outcome: details.learningOutcome,
    learning_methods: details.learningMethods,
    mandatory_activities: details.mandatoryActivities,
    required_knowledge: details.requiredKnowledge,
    recommended_knowledge: details.recommendedKnowledge,
    special_conditions: details.specialConditions,
    course_materials: details.courseMaterials,
    credit_reductions: details.creditReductions.map((r) => ({
      course_code: r.courseCode,
      reduction: r.reduction,
      from: r.fromTerm,
    })),
    // Codes match the study-program filter keys on timetable/schedule slots.
    study_programs: details.studyPrograms.map((p) => ({ code: p.code, name: p.name })),
    subject_areas: details.subjectAreas,
    department: details.department,
    contacts: details.contacts.map((c) => ({
      role: c.role,
      persons: c.persons.map((p) => p.name),
    })),
    course_links: details.courseLinks,
    years_offered: yearsOffered(details.availableYears),
    note: "Exam dates, times, aid codes, and rooms: use get_exam_info.",
  };
}

/** Renders one exam room as `"SL311 brun sone (Sluppenvegen 14), 82 candidates"`. */
function formatExamRoom(room: CourseExam["rooms"][number]): string {
  const base = room.building ? `${room.room} (${room.building})` : room.room;
  return room.candidates !== null ? `${base}, ${room.candidates} candidates` : base;
}

function shapeExam(exam: CourseExam): object {
  return {
    occasion: exam.occasion,
    season: exam.season,
    form: exam.form,
    weighting: exam.weighting,
    date: exam.date ?? exam.dateText,
    start_time: exam.time ?? exam.timeText,
    duration: exam.duration,
    aids: exam.aidCode,
    aids_meaning: exam.aidCodeDescription,
    system: exam.system,
    rooms: exam.rooms.map(formatExamRoom),
  };
}

async function examInfoForCourse(
  deps: ToolDeps,
  code: string,
  year: number | null,
  language: Language,
): Promise<object> {
  const details = await fetchDetails(deps, code, year, language);
  if (details === null) {
    return { course_code: code, note: NOT_FOUND_NOTE };
  }
  const shaped: Record<string, unknown> = {
    course_code: details.courseCode ?? code,
    course_name: details.courseName,
    study_year: details.studyYear,
    assessment: details.assessmentScheme,
    grading: details.gradeRule,
    notices: details.notices,
    exams: details.exams.map(shapeExam),
  };
  if (details.exams.length === 0) {
    shaped.note = "No exam occasions listed for this study year.";
  }
  return shaped;
}

/**
 * Exam logistics for one or more courses in one call: every exam occasion
 * with date, start time, duration, permitted-aids code (with its meaning),
 * exam system, and assigned rooms. Dates/rooms appear as NTNU publishes
 * them (rooms only days before the exam); unpublished fields are null.
 */
export async function getExamInfo(
  deps: ToolDeps,
  args: { course_codes: string[]; year?: number | null; language?: Language | null },
): Promise<object> {
  const seen = new Set<string>();
  const codes: string[] = [];
  for (const raw of args.course_codes) {
    const code = raw.trim().toUpperCase();
    if (code !== "" && !seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  const limited = codes.slice(0, EXAM_INFO_COURSE_LIMIT);
  const year = args.year ?? null;
  const language = args.language ?? "en";

  const courses = await Promise.all(
    limited.map((code) => examInfoForCourse(deps, code, year, language)),
  );

  const shaped: Record<string, unknown> = { courses };
  if (year !== null) {
    shaped.year = year;
  }
  if (codes.length > limited.length) {
    shaped.note =
      `Only the first ${EXAM_INFO_COURSE_LIMIT} of ${codes.length} courses were ` +
      "looked up; call again with the rest.";
  }
  return shaped;
}
