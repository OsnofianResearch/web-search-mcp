#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetch as undiciFetch } from 'undici';
import { lookup as dnsLookup } from 'node:dns/promises';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

type SearchResult = {
  url: string;
  title?: string;
  snippet?: string;
};

function isPrivateIp(ip: string): boolean {
  const privateRanges = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::1$/,
    /^::ffff:/i,
    /^f[cd][0-9a-f]{2}:/i,
    /^fe80:/i,
  ];
  return privateRanges.some(r => r.test(ip));
}

async function validateUrl(rawUrl: string): Promise<void> {
  const u = new URL(rawUrl);
  if (u.protocol !== 'https:') {
    throw new Error(`Only https: URLs are allowed, got: ${u.protocol}`);
  }
  const addresses = await dnsLookup(u.hostname, { all: true });
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error(`Requests to private/internal addresses are not allowed`);
  }
}

function normalizeDuckLink(rawHref: string): string {
  const href = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
  try {
    const u = new URL(href);
    if (u.hostname.includes('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      const uddg = u.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
    }
    return href;
  } catch {
    return href;
  }
}

// Minimal search implementation using DuckDuckGo HTML (no API key) as fallback
async function searchWebDuckDuckGo(query: string, limit: number): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const res = await undiciFetch(`https://duckduckgo.com/html?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; WebSearchMCP/1.0; +https://github.com/OsnofianResearch/web-search-mcp)'
    }
  });
  const html = await res.text();
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const results: SearchResult[] = [];
  const anchors = doc.querySelectorAll('#links .result__a');
  anchors.forEach((a: globalThis.Element) => {
    const href = (a as unknown as globalThis.HTMLAnchorElement).href;
    const title = a.textContent?.trim() || undefined;
    if (href) results.push({ url: normalizeDuckLink(href), title });
  });
  return results.slice(0, Math.max(1, Math.min(limit, 10)));
}

async function fetchWithLimit(url: string, timeoutMs: number, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await undiciFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WebSearchMCP/1.0; +https://github.com/OsnofianResearch/web-search-mcp)'
      },
      signal: controller.signal
    });
    const body = res.body as unknown as ReadableStream<Uint8Array> | null;
    if (!body) {
      const text = await res.text();
      return text.slice(0, maxBytes);
    }
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let received = 0;
    let chunks = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        chunks += decoder.decode(value, { stream: true });
        if (received >= maxBytes) {
          try {
            reader.cancel();
          } catch {
            // swallow cancel errors
          }
          break;
        }
      }
    }
    chunks += decoder.decode();
    return chunks.slice(0, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPageReadable(
  url: string,
  opts?: { timeoutMs?: number; maxBytes?: number }
): Promise<{ content: string; title?: string }>{
  await validateUrl(url);
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const maxBytes = opts?.maxBytes ?? 1_500_000;
  const html = await fetchWithLimit(url, timeoutMs, maxBytes);
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (article?.textContent) {
    return { content: article.textContent, title: article.title || undefined };
  }
  // Fallback to body text
  const text = dom.window.document.body?.textContent?.trim() || '';
  return { content: text };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = new McpServer({ name: 'web-search-mcp', version: '1.0.0' });

  server.tool(
    'search_web',
    'Search the web and return a list of result URLs and titles. Uses DuckDuckGo HTML.',
    { query: z.string(), limit: z.number().int().min(1).max(10).optional() },
    async (args) => {
      try {
        const results = await searchWebDuckDuckGo(args.query, args.limit ?? 5);
        return { content: [{ type: 'text', text: JSON.stringify(results) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: message }) }]
        };
      }
    }
  );

  server.tool(
    'fetch_page',
    'Fetch a page and extract its readable content and title using Readability.',
    { url: z.string().url().refine(u => u.startsWith('https://'), { message: 'Only https:// URLs are allowed' }) },
    async (args) => {
      try {
        const { content, title } = await fetchPageReadable(args.url);
        const payload = { url: args.url, title, content };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }]
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: 'text', text: JSON.stringify({ url: args.url, error: message }) }
          ]
        };
      }
    }
  );

  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { searchWebDuckDuckGo, fetchPageReadable, validateUrl, isPrivateIp, normalizeDuckLink, fetchWithLimit };
