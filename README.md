## Web Search MCP

Security-hardened fork of [guhcostan/web-search-mcp](https://github.com/guhcostan/web-search-mcp). Minimal MCP server that can search the web and extract readable page content.

### Add to LM Studio

<a href="https://lmstudio.ai/install-mcp?name=web-search-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhc2RydWJhbGluYXNteXRoL3dlYi1zZWFyY2gtbWNwQGxhdGVzdCJdfQ%3D%3D"><img src="https://files.lmstudio.ai/deeplink/mcp-install-light.svg" alt="Add MCP Server web-search-mcp to LM Studio" /></a>

Or add manually in LM Studio → Settings → MCP Servers:

```json
{
  "mcpServers": {
    "web-search-mcp": {
      "command": "npx",
      "args": ["-y", "@asdrubalinasmyth/web-search-mcp@latest"]
    }
  }
}
```

### Features

- **search_web**: Query the web (DuckDuckGo HTML) and return result URLs and titles
- **fetch_page**: Fetch any URL and extract readable content using Mozilla Readability + JSDOM

### Requirements

- Node.js 20+ (recommended: 20.18.1+)

### Install

```bash
npm install
```

### Run (stdio)

```bash
npm start
```

### Install globally

```bash
npm i -g @asdrubalinasmyth/web-search-mcp
```

Then reference the binary `web-search-mcp`.

### Integrate with MCP clients

#### Cursor

Add to your Cursor MCP settings (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "web-search-mcp": { "command": "web-search-mcp" }
  }
}
```

Without global install, use npx:

```json
{
  "mcpServers": {
    "web-search-mcp": {
      "command": "npx",
      "args": ["-y", "@asdrubalinasmyth/web-search-mcp@latest"]
    }
  }
}
```

#### LM Studio

In LM Studio → Settings → MCP Servers, add:

```json
{
  "mcpServers": {
    "web-search-mcp": {
      "command": "npx",
      "args": ["-y", "@asdrubalinasmyth/web-search-mcp@latest"]
    }
  }
}
```

#### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "web-search-mcp": {
      "command": "npx",
      "args": ["-y", "@asdrubalinasmyth/web-search-mcp@latest"]
    }
  }
}
```

### Tools

- **search_web**
  - input:
    - `query` (string, required)
    - `limit` (number, optional, 1–10, default 5)
  - output: array of `{ url: string; title?: string; snippet?: string }`

- **fetch_page**
  - input:
    - `url` (string URL, required)
  - output: `{ url: string; title?: string; content: string }`

### Development

Type-check, lint and tests:

```bash
npm run check
```

Run individually:

```bash
npm run build
npm run lint
npm test
```

### Notes

- Web search uses DuckDuckGo HTML; results may vary and are HTML-scraped (no API key required)
- Be mindful of target site terms of use and robots policies when fetching pages
- `fetch_page` only accepts `https://` URLs and blocks requests to private/internal IP ranges (SSRF protection)

### License

MIT