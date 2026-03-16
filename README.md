# MusicDB

A remote [MCP](https://modelcontextprotocol.io/) server that exposes the [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) as tools for AI assistants. Runs on Cloudflare Workers.

## Live Endpoint

```
https://musicdb-mcp.musicdb.workers.dev/mcp
```

## Adding to Your AI Assistant

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "musicdb": {
      "url": "https://musicdb-mcp.musicdb.workers.dev/mcp"
    }
  }
}
```

### Claude.ai

Go to **Settings > Integrations > Add custom integration** and enter:

```
https://musicdb-mcp.musicdb.workers.dev/mcp
```

### Any MCP Client

Point your MCP client at the URL above using **Streamable HTTP** transport.

## Tools

### Core Tools

| Tool | Description |
|------|-------------|
| `musicbrainz_lookup` | Look up any entity by its MusicBrainz ID (MBID) |
| `musicbrainz_browse` | Browse entities linked to another entity (e.g. all releases by an artist) |
| `musicbrainz_search` | Search using Lucene query syntax (e.g. `artist:radiohead`) |
| `musicbrainz_lookup_by_resource` | Look up by ISRC, ISWC, or disc ID |

### Convenience Tools

| Tool | Description |
|------|-------------|
| `musicbrainz_get_tracklist` | Formatted tracklist for a release with durations and credits |
| `musicbrainz_get_genres` | Genres and community tags for an entity |
| `musicbrainz_get_release_events` | Release dates and countries worldwide |
| `musicbrainz_url_lookup` | Find MusicBrainz entities from Spotify, Wikipedia, Discogs links |
| `musicbrainz_get_discography` | Full artist discography organized by type |
| `musicbrainz_get_credits` | Production credits and relationships for a recording or release |
| `musicbrainz_get_artist_relationships` | Band members, collaborators, and external links |
| `musicbrainz_find_covers` | All recordings of a musical work (covers, live versions) |
| `musicbrainz_compare_releases` | Side-by-side comparison of two releases |

## Example Prompts

- "Who are the members of Radiohead?"
- "Find the tracklist for Abbey Road"
- "What genres is Kendrick Lamar tagged with?"
- "Compare the US and UK editions of this album"
- "Find cover versions of Hallelujah"
- "What MusicBrainz entry does this Spotify link point to?"

## Development

```bash
npm install
npm run dev              # Start local dev server on port 8787
npm run deploy           # Deploy to Cloudflare Workers
```

**Test locally with MCP Inspector:**

```bash
npx @modelcontextprotocol/inspector
# Enter http://localhost:8787/mcp as the server URL
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **MCP SDK**: `@modelcontextprotocol/sdk` + `agents` (Cloudflare transport)
- **Validation**: Zod
- **Caching**: Cloudflare Cache API (24h lookups, 6h browses, 1h searches)
- **Rate Limiting**: 1.05s minimum between upstream requests + retry on 503/429

## License

MIT
