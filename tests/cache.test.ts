/**
 * TieredCache (memory + fake KV) behavior, plus the load-reduction property
 * the layer exists for: upstream results are shared across tools, so a
 * timetable fetched by one tool is not refetched by another.
 */
import { describe, expect, it } from "vitest";
import { type KVCacheBinding, TieredCache, TTLCache } from "../src/cache.js";
import { compareCourses } from "../src/compare.js";
import { getWeeklyTimetable } from "../src/tools.js";
import { cachedSchedules, cachedTimetable } from "../src/upstream.js";
import { jsonResponse, loadFixture, makeDeps, routeFetch } from "./helpers.js";

/** In-memory stand-in for a KV namespace, recording puts. */
function fakeKV(): KVCacheBinding & {
  store: Map<string, string>;
  reads: string[];
  puts: Array<{ key: string; expirationTtl?: number }>;
} {
  const store = new Map<string, string>();
  const reads: string[] = [];
  const puts: Array<{ key: string; expirationTtl?: number }> = [];
  return {
    store,
    reads,
    puts,
    async get(key: string, _type: "text") {
      reads.push(key);
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      puts.push({ key, expirationTtl: options?.expirationTtl });
      store.set(key, value);
    },
  };
}

describe("TieredCache", () => {
  it("writes both tiers and answers from memory without touching KV", async () => {
    const kv = fakeKV();
    const cache = new TieredCache(new TTLCache(), kv);
    await cache.set("k", { a: 1 }, 60_000);
    expect(kv.puts).toEqual([{ key: "v1:k", expirationTtl: 60 }]);
    expect(await cache.get("k", 60_000)).toEqual({ a: 1 });
    expect(kv.reads).toEqual([]);
  });

  it("enforces KV's 60s minimum expiration", async () => {
    const kv = fakeKV();
    const cache = new TieredCache(new TTLCache(), kv);
    await cache.set("k", 1, 1_000);
    expect(kv.puts[0]?.expirationTtl).toBe(60);
  });

  it("falls back to KV on a memory miss and repopulates memory", async () => {
    const kv = fakeKV();
    const warm = new TieredCache(new TTLCache(), kv);
    await warm.set("k", [1, 2, 3], 60_000);

    // Fresh memory tier, same KV — simulates a new isolate.
    const cold = new TieredCache(new TTLCache(), kv);
    expect(await cold.get("k", 60_000)).toEqual([1, 2, 3]);
    expect(kv.reads).toEqual(["v1:k"]);
    // Second read is served by the repopulated memory tier.
    expect(await cold.get("k", 60_000)).toEqual([1, 2, 3]);
    expect(kv.reads).toEqual(["v1:k"]);
  });

  it("misses when neither tier has the key", async () => {
    const cache = new TieredCache(new TTLCache(), fakeKV());
    expect(await cache.get("absent", 60_000)).toBeNull();
  });

  it("degrades KV failures to a miss instead of throwing", async () => {
    const broken: KVCacheBinding = {
      get: async () => {
        throw new Error("quota exceeded");
      },
      put: async () => {
        throw new Error("quota exceeded");
      },
    };
    const cache = new TieredCache(new TTLCache(), broken);
    await expect(cache.set("k", 1, 60_000)).resolves.toBeUndefined();
    // Memory tier still works even though the KV write failed.
    expect(await cache.get("k", 60_000)).toBe(1);
    expect(await cache.get("other", 60_000)).toBeNull();
  });

  it("works memory-only when no KV binding is present", async () => {
    const cache = new TieredCache();
    await cache.set("k", "v", 60_000);
    expect(await cache.get("k", 60_000)).toBe("v");
  });
});

describe("cross-tool upstream reuse", () => {
  it("compare_courses reuses a timetable already fetched by get_weekly_timetable", async () => {
    const { fetch, calls } = routeFetch([
      { match: "p_p_resource_id=timetable", respond: () => jsonResponse(loadFixture("timetable")) },
      { match: "emnesok", respond: () => jsonResponse(loadFixture("catalog_page")) },
      { match: "hentJSONTabellData", respond: () => jsonResponse(loadFixture("grades")) },
    ]);
    const deps = makeDeps(fetch);

    await getWeeklyTimetable(deps, { course_code: "TDT4100", year: 2026 });
    const timetableCalls = () =>
      calls.filter((c) => c.url.includes("p_p_resource_id=timetable")).length;
    expect(timetableCalls()).toBe(1);

    await compareCourses(deps, { course_codes: ["TDT4100"], year: 2026 });
    // compare_courses needed search + grades, but NOT another timetable fetch.
    expect(timetableCalls()).toBe(1);
  });

  it("revives schedule Dates after a KV round-trip", async () => {
    const kv = fakeKV();
    const warmDeps = makeDeps(
      routeFetch([
        { match: "schedules", respond: () => jsonResponse(loadFixture("schedules")) },
      ]).fetch,
    );
    warmDeps.cache = new TieredCache(new TTLCache(), kv);
    const first = await cachedSchedules(warmDeps, "TDT4100", 2026);
    expect(first[0]?.start).toBeInstanceOf(Date);

    // New isolate: fresh memory, same KV, and a fetch that MUST not be called.
    const coldDeps = makeDeps(
      routeFetch([
        {
          match: "",
          respond: () => {
            throw new Error("unexpected upstream fetch — KV should have answered");
          },
        },
      ]).fetch,
    );
    coldDeps.cache = new TieredCache(new TTLCache(), kv);
    const revived = await cachedSchedules(coldDeps, "TDT4100", 2026);
    expect(revived.length).toBe(first.length);
    expect(revived[0]?.start).toBeInstanceOf(Date);
    expect(revived[0]?.start.getTime()).toBe(first[0]?.start.getTime());
  });

  it("cachedTimetable normalizes the code so casing variants share one entry", async () => {
    const { fetch, calls } = routeFetch([
      { match: "p_p_resource_id=timetable", respond: () => jsonResponse(loadFixture("timetable")) },
    ]);
    const deps = makeDeps(fetch);
    await cachedTimetable(deps, "tdt4100", 2026);
    await cachedTimetable(deps, " TDT4100 ", 2026);
    expect(calls.length).toBe(1);
  });
});
