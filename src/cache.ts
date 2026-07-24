/**
 * Per-isolate in-memory TTL cache. Port of the Python `TTLCache` helper in
 * `mcp_server.py`: a plain object store keyed by an arbitrary string, with
 * entries expiring after a caller-supplied TTL (not a single fixed TTL per
 * cache instance, since different tools use different TTLs).
 */
interface CacheEntry {
  value: unknown;
  storedAt: number;
}

export class TTLCache {
  private readonly entries = new Map<string, CacheEntry>();

  /** Returns the cached value, or `null` if absent or older than `ttlMs`. */
  get(key: string, ttlMs: number): unknown | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > ttlMs) return null;
    return entry.value;
  }

  /** Stores `value` under `key`, stamped with the current time. */
  set(key: string, value: unknown): void {
    this.entries.set(key, { value, storedAt: Date.now() });
  }
}

/** TTL for catalog search results (spec: 1 hour). */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** TTL for `get_semesters` results (spec: 24 hours). */
export const SEMESTERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** TTL for per-course weekly timetables — may shift during term planning, so 1 hour. */
export const TIMETABLE_CACHE_TTL_MS = 60 * 60 * 1000;

/** TTL for per-course dated schedules — same volatility as timetables. */
export const SCHEDULE_CACHE_TTL_MS = 60 * 60 * 1000;

/** TTL for DBH grade data — historical statistics change roughly once a semester. */
export const GRADES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * TTL for scraped course pages — descriptions change yearly, but exam rooms
 * publish days before the exam and notices appear mid-term, so 6 hours.
 */
export const DETAILS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** TTL for the study-program catalog and study plans — change a few times a year. */
export const PROGRAMS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The slice of Cloudflare's `KVNamespace` this cache needs, typed structurally
 * so `deps.ts`/tests don't have to load `@cloudflare/workers-types` (its
 * ambient globals clash with `@types/node` — see the split-tsconfig note in
 * `server.ts`).
 */
export interface KVCacheBinding {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** Version prefix for KV keys — bump when cached shapes change incompatibly. */
const KV_KEY_PREFIX = "v1:";

/**
 * Two-tier TTL cache: per-isolate memory in front of a shared Workers KV
 * namespace. The point of the KV tier is to minimize load on NTNU's servers —
 * without it every isolate (per location, and again after every eviction)
 * refetches independently; with it each upstream resource is fetched roughly
 * once per TTL globally.
 *
 * Notes:
 * - KV failures (quota, transient errors) degrade to a cache miss, never to a
 *   tool failure; they are logged for Workers Logs.
 * - A KV hit is re-stamped into memory with a fresh TTL, so worst-case
 *   staleness is just under 2× the TTL — acceptable for slow-moving course
 *   data, and it keeps reads on the free tier's quota.
 * - Values must be JSON-serializable; callers revive rich types (e.g. `Date`)
 *   after a KV round-trip.
 */
export class TieredCache {
  private readonly memory: TTLCache;
  private readonly kv?: KVCacheBinding;

  constructor(memory: TTLCache = new TTLCache(), kv?: KVCacheBinding) {
    this.memory = memory;
    this.kv = kv;
  }

  async get(key: string, ttlMs: number): Promise<unknown | null> {
    const hit = this.memory.get(key, ttlMs);
    if (hit !== null) return hit;
    if (!this.kv) return null;
    try {
      const raw = await this.kv.get(`${KV_KEY_PREFIX}${key}`, "text");
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      this.memory.set(key, value);
      return value;
    } catch (err) {
      console.warn(`KV cache read failed for ${key}: ${String(err)}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.memory.set(key, value);
    if (!this.kv) return;
    try {
      await this.kv.put(`${KV_KEY_PREFIX}${key}`, JSON.stringify(value), {
        // KV enforces a 60s minimum; every TTL here is far above it anyway.
        expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)),
      });
    } catch (err) {
      console.warn(`KV cache write failed for ${key}: ${String(err)}`);
    }
  }
}
