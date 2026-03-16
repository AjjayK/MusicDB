import { cacheGet, cachePut, type OperationType } from "./cache.js";

const BASE_URL = "https://musicbrainz.org/ws/2";
const USER_AGENT = "MusicDB-MCP/1.0.0 ( https://github.com/AjjayK/MusicDB )";

// ── Retry configuration ─────────────────────────────────────────────────────

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1100;     // Just over 1s (MusicBrainz rate-limit window)
const MAX_DELAY_MS = 5000;
const RETRYABLE_STATUSES = [503, 429];

// ── Intra-request rate limiting ─────────────────────────────────────────────

const MIN_REQUEST_INTERVAL_MS = 1050;
let lastRequestTime = 0;

// ── ExecutionContext for non-blocking cache writes ──────────────────────────

let executionCtx: ExecutionContext | null = null;

export function setExecutionContext(ctx: ExecutionContext): void {
  executionCtx = ctx;
}

// ── Error class ─────────────────────────────────────────────────────────────

export class MusicBrainzError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforceRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestTime = Date.now();
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: MusicBrainzError | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
      await sleep(delay);
      lastRequestTime = Date.now();
    }

    const res = await fetch(url, init);

    if (res.ok) return res;

    if (RETRYABLE_STATUSES.includes(res.status) && attempt < MAX_RETRIES) {
      lastError = new MusicBrainzError(res.status, `Rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
      continue;
    }

    const body = await res.text();
    throw new MusicBrainzError(res.status, `MusicBrainz API ${res.status}: ${body}`);
  }

  throw lastError ?? new Error("Retry exhausted");
}

// ── Core request function ───────────────────────────────────────────────────

async function request(
  path: string,
  params: Record<string, string> = {},
  operationType: OperationType = "lookup",
): Promise<unknown> {
  params["fmt"] = "json";
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}?${qs}`;

  // 1. Check cache (no rate-limit cost for cache hits)
  const cached = await cacheGet(url);
  if (cached !== undefined) return cached;

  // 2. Enforce rate limit before hitting upstream
  await enforceRateLimit();

  // 3. Fetch with retry on 503/429
  const res = await fetchWithRetry(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  const data = await res.json();

  // 4. Write to cache (non-blocking if ExecutionContext available)
  const putPromise = cachePut(url, data, operationType);
  if (executionCtx) {
    executionCtx.waitUntil(putPromise);
  } else {
    await putPromise;
  }

  return data;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Lookup an entity by MBID. */
export function lookup(entity: string, mbid: string, inc?: string): Promise<unknown> {
  const params: Record<string, string> = {};
  if (inc) params["inc"] = inc;
  return request(`/${entity}/${mbid}`, params, "lookup");
}

/** Browse entities linked to another entity. */
export function browse(
  entity: string,
  linkedEntity: string,
  linkedMbid: string,
  limit: number,
  offset: number,
  inc?: string,
): Promise<unknown> {
  const params: Record<string, string> = {
    [linkedEntity]: linkedMbid,
    limit: String(limit),
    offset: String(offset),
  };
  if (inc) params["inc"] = inc;
  return request(`/${entity}`, params, "browse");
}

/** Search entities with Lucene query syntax. */
export function search(
  entity: string,
  query: string,
  limit: number,
  offset: number,
): Promise<unknown> {
  return request(`/${entity}`, { query, limit: String(limit), offset: String(offset) }, "search");
}

/** Lookup by non-MBID resource (ISRC, ISWC, disc ID). */
export function lookupByResource(
  resource: string,
  value: string,
  inc?: string,
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (inc) params["inc"] = inc;
  return request(`/${resource}/${value}`, params, "lookup");
}

/** Lookup a URL entity by its external URL (e.g. Spotify, Wikipedia link). */
export function lookupUrl(url: string, inc?: string): Promise<unknown> {
  const params: Record<string, string> = { resource: url };
  if (inc) params["inc"] = inc;
  return request("/url", params, "lookup");
}

/** Browse all pages of an entity (up to maxPages). Rate limiting handled by request(). */
export async function browseAll(
  entity: string,
  linkedEntity: string,
  linkedMbid: string,
  inc?: string,
  maxPages = 5,
): Promise<unknown[]> {
  const pageSize = 100;
  const all: unknown[] = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await browse(entity, linkedEntity, linkedMbid, pageSize, page * pageSize, inc) as Record<string, unknown>;
    const key = Object.keys(data).find((k) => Array.isArray(data[k]));
    const items = key ? (data[key] as unknown[]) : [];
    all.push(...items);
    const count = (data[`${entity}-count`] ?? data["count"] ?? 0) as number;
    if (all.length >= count || items.length < pageSize) break;
  }
  return all;
}
