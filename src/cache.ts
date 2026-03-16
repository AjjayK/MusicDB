export type OperationType = "lookup" | "browse" | "search";

const TTL_MAP: Record<OperationType, number> = {
  lookup: 86400,  // 24 hours — entity data rarely changes
  browse: 21600,  // 6 hours — new releases added occasionally
  search: 3600,   // 1 hour — rankings/new entries shift
};

/** Convert a MusicBrainz URL into a synthetic cache key on a worker-controlled domain. */
function toCacheKey(musicBrainzUrl: string): Request {
  const cacheUrl = musicBrainzUrl.replace(
    "https://musicbrainz.org/ws/2",
    "https://musicdb-cache.internal/ws/2",
  );
  return new Request(cacheUrl, { method: "GET" });
}

export async function cacheGet(url: string): Promise<unknown | undefined> {
  try {
    const response = await caches.default.match(toCacheKey(url));
    if (!response) return undefined;
    return response.json();
  } catch {
    return undefined;
  }
}

export async function cachePut(
  url: string,
  body: unknown,
  operationType: OperationType,
): Promise<void> {
  try {
    const ttl = TTL_MAP[operationType];
    const response = new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${ttl}`,
      },
    });
    await caches.default.put(toCacheKey(url), response);
  } catch {
    // Cache write failures are non-fatal
  }
}
