# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MusicDB is a remote MCP (Model Context Protocol) server that exposes the MusicBrainz API as tools for AI assistants. It runs on **Cloudflare Workers** using the official `@modelcontextprotocol/sdk` with Cloudflare's `agents` package for transport.

## Tech Stack

- **Runtime**: Cloudflare Workers (edge, serverless)
- **Language**: TypeScript (strict mode)
- **MCP SDK**: `@modelcontextprotocol/sdk` (official) + `agents` (Cloudflare's transport/handler)
- **Validation**: Zod for tool input schemas
- **Build/Deploy**: Wrangler CLI (bundles with esbuild internally)

## Commands

```bash
npm run dev          # Start local dev server (wrangler dev --port 8787)
npm run deploy       # Deploy to Cloudflare Workers
npx wrangler types   # Regenerate worker-configuration.d.ts (Env types)
```

**Testing the MCP server locally:**
```bash
npx @modelcontextprotocol/inspector
# Enter http://localhost:8787/mcp as the server URL
```

**Deployed endpoint**: `https://<worker-name>.<subdomain>.workers.dev/mcp`

## Architecture

### Transport Layer

Uses `createMcpHandler` (stateless) from the `agents` package with Streamable HTTP transport on `/mcp`. A fresh `McpServer` instance is created per request — this is required by the SDK to prevent cross-client response leakage.

The Worker entry point (`src/index.ts`) handles `/` for health-check JSON, and delegates everything else to the MCP handler. The `createServer()` factory registers all MusicBrainz tools on each `McpServer` instance.

### Tool Organization

MCP tools map to MusicBrainz API operations across three categories:

| Category | Pattern | Example |
|----------|---------|---------|
| **Lookup** | `GET /ws/2/<entity>/<MBID>?inc=<subqueries>&fmt=json` | Get artist by MBID with aliases |
| **Browse** | `GET /ws/2/<entity>?<linked_entity>=<MBID>&limit=N&offset=N&fmt=json` | List releases by artist |
| **Search** | `GET /ws/2/<entity>?query=<lucene>&limit=N&offset=N&fmt=json` | Search recordings by name |

**Core entities**: `artist`, `release`, `release-group`, `recording`, `label`, `work`, `event`, `area`, `instrument`, `place`, `series`, `genre`, `url`

**Lookup-only resources** (not MBIDs): `discid`, `isrc`, `iswc`

### MusicBrainz API Constraints

- **Base URL**: `https://musicbrainz.org/ws/2/`
- **Rate limit**: 1 request/second per IP. Returns HTTP 503 on exceed.
- **User-Agent header is mandatory**: Format `AppName/Version ( contact-url-or-email )`. Example: `MusicDB-MCP/1.0.0 ( https://github.com/user/musicdb-mcp )`
- **JSON responses**: Use `Accept: application/json` header or `&fmt=json` query param (default is XML)
- **No auth needed** for read-only operations (lookups, browses, searches)
- **Pagination**: `limit` (max 100, default 25) and `offset` params. Browse release results may return fewer than `limit` due to a 500-track-per-page cap.
- **`inc` params** control subqueries (joined with `+`): `artist-credits`, `labels`, `recordings`, `releases`, `aliases`, `genres`, `tags`, `ratings`, `*-rels` (relationship types)

### Search Query Syntax

MusicBrainz search uses Lucene query syntax:
- Field-specific: `artist:metallica`, `release:"abbey road"`
- Boolean: `artist:fred AND type:group AND country:US`
- Quoted phrases for exact match: `"we will rock you"`
- Unqualified terms search default fields

Key search fields vary by entity (e.g., artist search supports `artist`, `alias`, `arid`, `area`, `country`, `type`, `gender`, `tag`).

## Wrangler Configuration

`wrangler.jsonc` must include:
- `compatibility_flags: ["nodejs_compat"]` — required by the `agents` package

### Caching, Rate Limiting & Retry

All outbound requests to MusicBrainz flow through `request()` in `src/api.ts`, which applies three layers:

1. **Cloudflare Cache API** (`src/cache.ts`): Responses are cached using synthetic cache keys (`musicdb-cache.internal/...`). TTLs vary by operation: lookups 24h, browses 6h, searches 1h. Cache writes use `ctx.waitUntil()` for non-blocking puts. Cache failures never break the app.

2. **Intra-request rate limiter**: A module-level `lastRequestTime` enforces 1.05s minimum gap between outbound fetches. Only applies on cache misses. Tools making multiple API calls (`browseAll`, `find_covers`, `compare_releases`) automatically respect this.

3. **Retry with exponential backoff**: On HTTP 503/429, retries up to 2 times with delays of 1.1s, 2.2s. Retry delays also update the rate limiter timestamp to avoid double-delaying.

`setExecutionContext(ctx)` is called at the top of the Worker fetch handler to plumb `ExecutionContext` into the API layer.

## Key Decisions

- **Stateless (createMcpHandler) over stateful (McpAgent)**: Avoids Durable Objects complexity. Fresh `McpServer` per request as required by SDK v1.26+.
- **Full MusicBrainz API coverage**: All 13 core entity types with lookup, browse, and search operations.
- **No authentication proxy**: Only read-only MusicBrainz operations (no user-tags, ratings submission, or collection management).
- **No cross-request rate limiting**: Would require KV or Durable Objects. Caching + intra-request delays + retry logic is sufficient for a personal MCP server.
