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

/** TTL for `search_courses` results (spec: 1 hour). */
export const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;

/** TTL for `get_semesters` results (spec: 24 hours). */
export const SEMESTERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
