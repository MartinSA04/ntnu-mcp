# ntnu-mcp

A remote [MCP](https://modelcontextprotocol.io) server that exposes NTNU
(Norwegian University of Science and Technology) course data to LLM assistants
— course catalog search, teaching schedules, weekly timetables, and grade
statistics, plus two comparison tools for students choosing between courses.
Runs as a Cloudflare Worker; no installation required on the client side.

## Tools

Eight tools, all read-only:

- **`search_courses`** — free-text search of NTNU's course catalog for a given year; returns codes, names, campus, and exam dates.
- **`get_course_schedule`** — every dated teaching activity (lectures, labs) for a course in a year, with Oslo-local times and rooms.
- **`get_weekly_timetable`** — the recurring weekly timetable grid for a course: weekday, times, ISO-week ranges, and rooms.
- **`get_grade_distribution`** — historical grade distribution for a course, per year and semester, with counts and percentages.
- **`get_course_versions`** — the DBH-versioned course codes (e.g. `TDT4100-1`) behind a bare course code, useful when grade lookups come back empty.
- **`get_semesters`** — NTNU's terms with ids like `26h`/`26v`, teaching weeks, exam-period dates, and which term is current.
- **`compare_courses`** — side-by-side comparison of several courses: name, campus, exam dates, weekly teaching hours, and latest grade distribution.
- **`check_timetable_conflicts`** — pairwise check for weekly-schedule clashes and exam-date collisions across a set of courses, before registering for them.

## Connecting

Once deployed, paste the worker's MCP URL — for example
`https://<your-worker>.workers.dev/mcp` — into Claude's or ChatGPT's custom
connector settings. **This is a placeholder**: no worker has been deployed
yet, so no real URL exists at this time. Deployment is pending (see
[Deploy](#deploy) below).

The server requires no authentication, since it only serves public,
read-only NTNU course data.

## Architecture

All NTNU upstream knowledge — endpoints, retry policy, parsing of the
Liferay catalog, DBH grade statistics, and TP semester data — lives in the
[`ntnu-api`](https://github.com/MartinSA04/ntnu-api) TypeScript client
library, which this repo depends on as an npm package. **Upstream fixes and
new data sources land in `ntnu-api`, not here.** This repo's only job is to
call that typed client and shape its output for LLM consumption: English
names with Norwegian fallback, Oslo-local timestamps, grade rows collapsed
into per-term distribution tables, and guidance notes on empty results. This
layering is set out in `ntnu-api`'s
[TypeScript migration spec](https://github.com/MartinSA04/ntnu-api/blob/main/docs/ts-migration-spec.md).

## Local development

Requires Node 22 (pinned via [mise](https://mise.jdx.dev/)).

```sh
mise install     # installs the pinned Node version
npm install
```

Common tasks, available both as mise tasks and npm scripts:

```sh
mise run dev          # npm run dev       — wrangler dev, local worker with hot reload
mise run test          # npm test          — vitest, over captured fixtures (no live network)
mise run typecheck     # npm run typecheck — tsc --noEmit
mise run lint          # npm run lint      — biome check
mise run fmt           # npm run fmt       — biome check --write
mise run check         # lint + typecheck + test
```

Tests run under plain Node (not the Workers pool) with vitest, driving the
tool functions directly against fetch fixtures captured verbatim from
`ntnu-api`'s test suite — no calls to real NTNU services are made in CI or
locally.

## Deploy

```sh
npm run deploy   # wrangler deploy
```

Runs on Cloudflare's free plan: the MCP session state is backed by a Durable
Object using SQLite storage, which is available on the free tier (no Workers
Paid subscription required unless per-request CPU limits are hit at scale).

## License

MIT — see [LICENSE](LICENSE).
