import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { lookup, browse, browseAll, search, lookupByResource, lookupUrl, MusicBrainzError, setExecutionContext } from "./api.js";

// -- Shared schemas ----------------------------------------------------------

const CORE_ENTITIES = [
  "artist", "release", "release-group", "recording", "label",
  "work", "event", "area", "instrument", "place", "series", "genre", "url",
] as const;

const EntityEnum = z.enum(CORE_ENTITIES);

const INC_DESCRIPTION = `Optional subquery includes, joined with "+". Examples: "aliases", "artist-credits+recordings", "genres+tags", "url-rels+artist-rels". Common values: aliases, annotation, tags, ratings, genres, artist-credits, labels, recordings, releases, release-groups, works, discids, media, isrcs, area-rels, artist-rels, event-rels, label-rels, place-rels, recording-rels, release-rels, release-group-rels, url-rels, work-rels`;

// -- Helpers ------------------------------------------------------------------

function textResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const message = err instanceof MusicBrainzError
    ? `MusicBrainz error ${err.status}: ${err.message}`
    : err instanceof Error
      ? err.message
      : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// -- Browse link mappings -----------------------------------------------------

const BROWSE_LINKS: Record<string, readonly string[]> = {
  "artist":        ["area", "collection", "recording", "release", "release-group", "work"],
  "collection":    ["area", "artist", "editor", "event", "label", "place", "recording", "release", "release-group", "work"],
  "event":         ["area", "artist", "collection", "place"],
  "label":         ["area", "collection", "release"],
  "place":         ["area", "collection"],
  "recording":     ["artist", "collection", "release", "work"],
  "release":       ["area", "artist", "collection", "label", "recording", "release-group", "track", "track_artist"],
  "release-group": ["artist", "collection", "release"],
  "series":        ["collection"],
  "work":          ["artist", "collection"],
  "url":           ["resource"],
};

// -- Server factory -----------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "MusicDB",
    version: "1.0.0",
  });

  // ── Lookup by MBID ──────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_lookup",
    `Look up a MusicBrainz entity by its MBID (UUID). Returns detailed information about the entity. Supported entities: ${CORE_ENTITIES.join(", ")}.`,
    {
      entity: EntityEnum.describe("The entity type to look up."),
      mbid: z.string().uuid().describe("The MusicBrainz ID (UUID) of the entity."),
      inc: z.string().optional().describe(INC_DESCRIPTION),
    },
    async ({ entity, mbid, inc }) => {
      try {
        return textResult(await lookup(entity, mbid, inc));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Lookup by ISRC / ISWC / Disc ID ─────────────────────────────────────
  server.tool(
    "musicbrainz_lookup_by_resource",
    "Look up recordings by ISRC, works by ISWC, or releases by disc ID. Use this when you have a non-MBID identifier.",
    {
      resource: z.enum(["isrc", "iswc", "discid"]).describe("The resource type."),
      value: z.string().describe("The ISRC, ISWC, or disc ID value."),
      inc: z.string().optional().describe(INC_DESCRIPTION),
    },
    async ({ resource, value, inc }) => {
      try {
        return textResult(await lookupByResource(resource, value, inc));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Browse ──────────────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_browse",
    `Browse MusicBrainz entities linked to another entity. For example: browse all releases by an artist, all recordings on a release, all events at a place. Returns paginated results. Valid entity→linked_entity combinations: ${Object.entries(BROWSE_LINKS).map(([e, links]) => `${e} by [${links.join(", ")}]`).join("; ")}.`,
    {
      entity: z.string().describe("The entity type to retrieve (e.g. 'release', 'recording')."),
      linked_entity: z.string().describe("The type of linked entity to filter by (e.g. 'artist', 'label')."),
      mbid: z.string().uuid().describe("The MBID of the linked entity."),
      limit: z.number().min(1).max(100).default(25).describe("Number of results (1-100, default 25)."),
      offset: z.number().min(0).default(0).describe("Pagination offset (default 0)."),
      inc: z.string().optional().describe(INC_DESCRIPTION),
    },
    async ({ entity, linked_entity, mbid, limit, offset, inc }) => {
      try {
        const validLinks = BROWSE_LINKS[entity];
        if (!validLinks?.includes(linked_entity)) {
          return errorResult(
            `Cannot browse '${entity}' by '${linked_entity}'. Valid linked entities for '${entity}': ${validLinks?.join(", ") ?? "none (entity not browseable)"}`,
          );
        }
        return textResult(await browse(entity, linked_entity, mbid, limit, offset, inc));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Search ──────────────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_search",
    `Search MusicBrainz using Lucene query syntax. Supports field-specific searches (e.g. artist:metallica, release:"abbey road"), boolean operators (AND, OR, NOT), and quoted phrases for exact match. Searchable entities: artist, release, release-group, recording, label, work, event, area, instrument, place, series, tag, annotation, url. Key search fields per entity — artist: artist, alias, type, country, tag; recording: recording, artist, release, dur, isrc; release: release, artist, barcode, country, date, label, status, type; release-group: releasegroup, artist, primarytype; work: work, artist, iswc, type; label: label, type, country, code.`,
    {
      entity: z.string().describe("The entity type to search (e.g. 'artist', 'recording')."),
      query: z.string().describe('Lucene query string. Examples: \'artist:radiohead\', \'"bohemian rhapsody" AND artist:queen\', \'release:"dark side of the moon" AND country:US\'.'),
      limit: z.number().min(1).max(100).default(25).describe("Number of results (1-100, default 25)."),
      offset: z.number().min(0).default(0).describe("Pagination offset (default 0)."),
    },
    async ({ entity, query, limit, offset }) => {
      try {
        return textResult(await search(entity, query, limit, offset));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // CONVENIENCE TOOLS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Get Tracklist ─────────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_get_tracklist",
    "Get a formatted tracklist for a release. Returns track numbers, titles, durations, and artist credits organized by medium (disc).",
    {
      release_mbid: z.string().uuid().describe("The MBID of the release."),
    },
    async ({ release_mbid }) => {
      try {
        const data = await lookup("release", release_mbid, "recordings+artist-credits+media") as Record<string, unknown>;
        const media = (data["media"] ?? []) as Array<Record<string, unknown>>;
        const result = {
          title: data["title"],
          artist_credit: data["artist-credit"],
          date: data["date"],
          media: media.map((m) => ({
            position: m["position"],
            format: m["format"],
            track_count: m["track-count"],
            tracks: ((m["tracks"] ?? []) as Array<Record<string, unknown>>).map((t) => ({
              number: t["number"],
              title: t["title"],
              length_ms: t["length"],
              length_display: t["length"] ? `${Math.floor((t["length"] as number) / 60000)}:${String(Math.floor(((t["length"] as number) % 60000) / 1000)).padStart(2, "0")}` : null,
              artist_credit: t["artist-credit"],
            })),
          })),
        };
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Get Genres/Tags ───────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_get_genres",
    "Get genres and tags for an artist, release-group, recording, or release. Returns both official genres and community tags with vote counts.",
    {
      entity: z.enum(["artist", "release-group", "recording", "release"]).describe("The entity type."),
      mbid: z.string().uuid().describe("The MBID of the entity."),
    },
    async ({ entity, mbid }) => {
      try {
        const data = await lookup(entity, mbid, "genres+tags") as Record<string, unknown>;
        return textResult({
          name: data["name"] ?? data["title"],
          genres: data["genres"] ?? [],
          tags: data["tags"] ?? [],
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Get Release Events ────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_get_release_events",
    "Get all release events (dates and countries) for a release. Shows when and where an album was released worldwide.",
    {
      release_mbid: z.string().uuid().describe("The MBID of the release."),
    },
    async ({ release_mbid }) => {
      try {
        const data = await lookup("release", release_mbid, "labels") as Record<string, unknown>;
        return textResult({
          title: data["title"],
          date: data["date"],
          country: data["country"],
          release_events: data["release-events"] ?? [],
          label_info: data["label-info"] ?? [],
          barcode: data["barcode"],
          status: data["status"],
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── URL Lookup ────────────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_url_lookup",
    "Find which MusicBrainz entities link to a given URL. Useful for finding the MusicBrainz entry for a Spotify, Bandcamp, Wikipedia, Discogs, or other external link.",
    {
      url: z.string().url().describe("The external URL to look up (e.g. a Spotify artist URL, Wikipedia page)."),
      inc: z.string().optional().describe("Optional includes for related data, e.g. 'artist-rels+release-rels'."),
    },
    async ({ url, inc }) => {
      try {
        return textResult(await lookupUrl(url, inc));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Get Discography ───────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_get_discography",
    "Get an artist's full discography organized by release group type (albums, singles, EPs, compilations, etc.).",
    {
      artist_mbid: z.string().uuid().describe("The MBID of the artist."),
    },
    async ({ artist_mbid }) => {
      try {
        const items = await browseAll("release-group", "artist", artist_mbid, "artist-credits") as Array<Record<string, unknown>>;
        const grouped: Record<string, unknown[]> = {};
        for (const rg of items) {
          const type = (rg["primary-type"] as string) ?? "Other";
          if (!grouped[type]) grouped[type] = [];
          grouped[type]!.push({
            mbid: rg["id"],
            title: rg["title"],
            first_release_date: rg["first-release-date"],
            primary_type: rg["primary-type"],
            secondary_types: rg["secondary-types"],
            artist_credit: rg["artist-credit"],
          });
        }
        // Sort each group by date
        for (const type of Object.keys(grouped)) {
          grouped[type]!.sort((a: any, b: any) =>
            (a.first_release_date ?? "").localeCompare(b.first_release_date ?? ""),
          );
        }
        return textResult({ artist_mbid, total: items.length, discography: grouped });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Get Credits ───────────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_get_credits",
    "Get detailed credits/relationships for a recording or release. Returns who produced, performed, engineered, mixed, mastered, wrote, and where it was recorded.",
    {
      entity: z.enum(["recording", "release"]).describe("The entity type."),
      mbid: z.string().uuid().describe("The MBID of the recording or release."),
    },
    async ({ entity, mbid }) => {
      try {
        const inc = "artist-rels+label-rels+place-rels+work-rels+url-rels+artist-credits";
        const data = await lookup(entity, mbid, inc) as Record<string, unknown>;
        const relations = (data["relations"] ?? []) as Array<Record<string, unknown>>;
        const categorized: Record<string, unknown[]> = {};
        for (const rel of relations) {
          const type = (rel["type"] as string) ?? "other";
          if (!categorized[type]) categorized[type] = [];
          categorized[type]!.push({
            direction: rel["direction"],
            target_type: rel["target-type"],
            artist: rel["artist"],
            label: rel["label"],
            place: rel["place"],
            work: rel["work"],
            url: rel["url"],
            attributes: rel["attributes"],
            begin: rel["begin"],
            end: rel["end"],
          });
        }
        return textResult({
          title: data["title"],
          artist_credit: data["artist-credit"],
          credits: categorized,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Get Artist Relationships ──────────────────────────────────────────────
  server.tool(
    "musicbrainz_get_artist_relationships",
    "Get an artist's relationships: band members, collaborators, associated acts, and external links (social media, streaming, Wikipedia, etc.).",
    {
      artist_mbid: z.string().uuid().describe("The MBID of the artist."),
    },
    async ({ artist_mbid }) => {
      try {
        const data = await lookup("artist", artist_mbid, "artist-rels+url-rels+label-rels+aliases") as Record<string, unknown>;
        const relations = (data["relations"] ?? []) as Array<Record<string, unknown>>;
        const artists: unknown[] = [];
        const urls: unknown[] = [];
        const other: unknown[] = [];
        for (const rel of relations) {
          const targetType = rel["target-type"] as string;
          if (targetType === "artist") {
            artists.push({
              type: rel["type"],
              direction: rel["direction"],
              artist: rel["artist"],
              attributes: rel["attributes"],
              begin: rel["begin"],
              end: rel["end"],
              ended: rel["ended"],
            });
          } else if (targetType === "url") {
            urls.push({
              type: rel["type"],
              url: (rel["url"] as Record<string, unknown>)?.["resource"],
            });
          } else {
            other.push(rel);
          }
        }
        return textResult({
          name: data["name"],
          type: data["type"],
          aliases: data["aliases"],
          artist_relationships: artists,
          external_links: urls,
          other_relationships: other,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Find Covers / Other Recordings of a Work ─────────────────────────────
  server.tool(
    "musicbrainz_find_covers",
    "Find all recordings of a musical work (composition). Use this to discover cover versions, live performances, and alternative recordings of a song.",
    {
      work_mbid: z.string().uuid().describe("The MBID of the work (composition)."),
      limit: z.number().min(1).max(100).default(25).describe("Number of results (1-100, default 25)."),
      offset: z.number().min(0).default(0).describe("Pagination offset (default 0)."),
    },
    async ({ work_mbid, limit, offset }) => {
      try {
        const workData = await lookup("work", work_mbid, "aliases") as Record<string, unknown>;
        const recordings = await browse("recording", "work", work_mbid, limit, offset, "artist-credits") as Record<string, unknown>;
        return textResult({
          work: {
            title: workData["title"],
            mbid: workData["id"],
            type: workData["type"],
            aliases: workData["aliases"],
          },
          recording_count: recordings["recording-count"],
          recordings: ((recordings["recordings"] ?? []) as Array<Record<string, unknown>>).map((r) => ({
            mbid: r["id"],
            title: r["title"],
            length_ms: r["length"],
            artist_credit: r["artist-credit"],
            first_release_date: r["first-release-date"],
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── Compare Releases ──────────────────────────────────────────────────────
  server.tool(
    "musicbrainz_compare_releases",
    "Compare two releases side by side (e.g. different editions, regional variants, reissues). Shows differences in tracklists, labels, formats, and release dates.",
    {
      release_mbid_a: z.string().uuid().describe("The MBID of the first release."),
      release_mbid_b: z.string().uuid().describe("The MBID of the second release."),
    },
    async ({ release_mbid_a, release_mbid_b }) => {
      try {
        const inc = "recordings+artist-credits+media+labels";
        // Sequential to respect MusicBrainz 1 req/sec rate limit
        const a = await lookup("release", release_mbid_a, inc) as Record<string, unknown>;
        const b = await lookup("release", release_mbid_b, inc) as Record<string, unknown>;
        const summarize = (r: Record<string, unknown>) => {
          const media = (r["media"] ?? []) as Array<Record<string, unknown>>;
          return {
            mbid: r["id"],
            title: r["title"],
            date: r["date"],
            country: r["country"],
            status: r["status"],
            barcode: r["barcode"],
            label_info: r["label-info"],
            media: media.map((m) => ({
              position: m["position"],
              format: m["format"],
              track_count: m["track-count"],
              tracks: ((m["tracks"] ?? []) as Array<Record<string, unknown>>).map((t) => ({
                number: t["number"],
                title: t["title"],
                length_ms: t["length"],
              })),
            })),
          };
        };
        return textResult({
          release_a: summarize(a),
          release_b: summarize(b),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// -- Worker entry point -------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setExecutionContext(ctx);
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "MusicDB MCP Server",
          version: "1.0.0",
          mcp_endpoint: "/mcp",
          description: "MCP server exposing the MusicBrainz API for AI assistants.",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // New McpServer per request — required for stateless handlers
    return createMcpHandler(createServer())(request, env, ctx);
  },
};
