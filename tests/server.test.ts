import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  fetchPageReadable,
  searchWebDuckDuckGo,
  validateUrl,
  isPrivateIp,
  normalizeDuckLink,
  fetchWithLimit
} from '../src/server.js';

// Mock dns/promises so tests don't need real network DNS resolution
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
}));

describe('web-search-mcp tools', () => {
  const mockAgent = new MockAgent();

  beforeAll(async () => {
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterAll(async () => {
    await mockAgent.close();
  });

  it('searchWebDuckDuckGo parses HTML results', async () => {
    const html = `
      <div id="links">
        <div class="result">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">
            Result A
          </a>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.com/b">Result B</a>
        </div>
      </div>
    `;
    const duck = mockAgent.get('https://duckduckgo.com');
    duck
      .intercept({ path: /\/html.*/i, method: 'GET' })
      .reply(200, html, { headers: { 'Content-Type': 'text/html' } });

    const results = await searchWebDuckDuckGo('query', 5);
    expect(results.length).toBe(2);
    expect(results[0].url).toBe('https://example.com/a');
    expect(results[0].title).toBe('Result A');
  });

  it('fetchPageReadable extracts content using Readability', async () => {
    const html = `
      <html><head><title>Page T</title></head>
      <body>
        <article><h1>Headline</h1><p>Hello world content.</p></article>
      </body></html>
    `;
    const origin = mockAgent.get('https://example.org');
    origin.intercept({ path: '/page', method: 'GET' }).reply(200, html, {
      headers: { 'Content-Type': 'text/html' }
    });

    const page = await fetchPageReadable('https://example.org/page');
    expect(page.content).toContain('Hello world');
  });

  it('fetchPageReadable truncates large responses and handles timeouts', async () => {
    const big = 'x'.repeat(2_000_000);
    const origin = mockAgent.get('https://big.example');
    origin
      .intercept({ path: '/x', method: 'GET' })
      .reply(200, big, { headers: { 'Content-Type': 'text/html' } });
    const start = Date.now();
    const result = await fetchPageReadable('https://big.example/x', {
      maxBytes: 200_000,
      timeoutMs: 5000
    });
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThanOrEqual(200_000);
    expect(Date.now() - start).toBeLessThan(6000);
  });
});

describe('isPrivateIp', () => {
  it('returns true for loopback IPv4', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
  });

  it('returns true for private 10.x', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
  });

  it('returns true for private 172.16-31.x', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
  });

  it('returns true for private 192.168.x', () => {
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('returns true for link-local 169.254.x', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('returns true for IPv6 loopback', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('returns true for IPv6 ULA fc00:', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
  });

  it('returns true for IPv6 ULA fd00:', () => {
    expect(isPrivateIp('fd00::1')).toBe(true);
  });

  it('returns true for IPv4-mapped IPv6 ::ffff:', () => {
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('returns true for IPv6 link-local fe80:', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('returns false for public IPs', () => {
    expect(isPrivateIp('93.184.216.34')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });
});

describe('validateUrl', () => {
  it('throws for non-https URLs', async () => {
    await expect(validateUrl('http://example.com')).rejects.toThrow('Only https:');
  });

  it('throws for ftp:// protocol', async () => {
    await expect(validateUrl('ftp://example.com')).rejects.toThrow('Only https:');
  });

  it('throws for private IP resolved by DNS', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }] as never);
    await expect(validateUrl('https://internal.example.com')).rejects.toThrow(
      'private/internal'
    );
  });

  it('throws when DNS resolves to 127.0.0.1', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(validateUrl('https://localhost.example.com')).rejects.toThrow('private/internal');
  });

  it('throws when DNS resolves to cloud metadata address 169.254.169.254', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    await expect(validateUrl('https://metadata.example.com')).rejects.toThrow('private/internal');
  });

  it('allows valid https URL resolving to public IP', async () => {
    await expect(validateUrl('https://example.com')).resolves.toBeUndefined();
  });
});

describe('normalizeDuckLink', () => {
  it('converts protocol-relative // links to https://', () => {
    expect(normalizeDuckLink('//example.com/page')).toBe('https://example.com/page');
  });

  it('returns already-absolute https:// links unchanged', () => {
    expect(normalizeDuckLink('https://example.com/page')).toBe('https://example.com/page');
  });

  it('extracts URL from DuckDuckGo redirect with uddg= param', () => {
    expect(
      normalizeDuckLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath')
    ).toBe('https://example.com/path');
  });

  it('returns the normalized href when DuckDuckGo redirect has no uddg= param', () => {
    expect(normalizeDuckLink('//duckduckgo.com/l/?other=value')).toBe(
      'https://duckduckgo.com/l/?other=value'
    );
  });

  it('returns original string for invalid URLs', () => {
    const invalid = 'not a url at all :::';
    expect(normalizeDuckLink(invalid)).toBe(invalid);
  });
});

describe('fetchWithLimit', () => {
  const mockAgent = new MockAgent();

  beforeAll(async () => {
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterAll(async () => {
    await mockAgent.close();
  });

  it('returns full body text for normal responses', async () => {
    const origin = mockAgent.get('https://fetch-limit.example');
    origin
      .intercept({ path: '/data', method: 'GET' })
      .reply(200, 'hello world', { headers: { 'Content-Type': 'text/plain' } });

    const result = await fetchWithLimit('https://fetch-limit.example/data', 5000, 1_000_000);
    expect(result).toBe('hello world');
  });

  it('truncates response at maxBytes', async () => {
    const body = 'a'.repeat(1000);
    const origin = mockAgent.get('https://fetch-limit.example');
    origin
      .intercept({ path: '/large', method: 'GET' })
      .reply(200, body, { headers: { 'Content-Type': 'text/plain' } });

    const result = await fetchWithLimit('https://fetch-limit.example/large', 5000, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('aborts on timeout', async () => {
    const origin = mockAgent.get('https://fetch-limit.example');
    origin
      .intercept({ path: '/slow', method: 'GET' })
      .reply(200, 'late response', { headers: { 'Content-Type': 'text/plain' } })
      .delay(2000);

    await expect(
      fetchWithLimit('https://fetch-limit.example/slow', 50, 1_000_000)
    ).rejects.toThrow();
  }, 5000);
});

describe('searchWebDuckDuckGo', () => {
  const mockAgent = new MockAgent();

  beforeAll(async () => {
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterAll(async () => {
    await mockAgent.close();
  });

  it('clamps limit above 10 to return at most 10 results', async () => {
    const anchors = Array.from(
      { length: 15 },
      (_, i) => `<a class="result__a" href="https://example.com/${i}">Result ${i}</a>`
    ).join('');
    const html = `<div id="links">${anchors}</div>`;
    const duck = mockAgent.get('https://duckduckgo.com');
    duck
      .intercept({ path: /\/html.*/i, method: 'GET' })
      .reply(200, html, { headers: { 'Content-Type': 'text/html' } });

    const results = await searchWebDuckDuckGo('query', 15);
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it('clamps limit of 0 to return at least 1 result', async () => {
    const html = `<div id="links"><a class="result__a" href="https://example.com/1">R1</a></div>`;
    const duck = mockAgent.get('https://duckduckgo.com');
    duck
      .intercept({ path: /\/html.*/i, method: 'GET' })
      .reply(200, html, { headers: { 'Content-Type': 'text/html' } });

    const results = await searchWebDuckDuckGo('query', 0);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty array when no .result__a anchors in HTML', async () => {
    const html = `<div id="links"><p>No results found.</p></div>`;
    const duck = mockAgent.get('https://duckduckgo.com');
    duck
      .intercept({ path: /\/html.*/i, method: 'GET' })
      .reply(200, html, { headers: { 'Content-Type': 'text/html' } });

    const results = await searchWebDuckDuckGo('noresults', 5);
    expect(results).toEqual([]);
  });

  it('skips anchors without href', async () => {
    const html = `
      <div id="links">
        <a class="result__a">No href anchor</a>
        <a class="result__a" href="https://example.com/valid">Valid</a>
      </div>
    `;
    const duck = mockAgent.get('https://duckduckgo.com');
    duck
      .intercept({ path: /\/html.*/i, method: 'GET' })
      .reply(200, html, { headers: { 'Content-Type': 'text/html' } });

    const results = await searchWebDuckDuckGo('skiphref', 5);
    expect(results.every(r => r.url)).toBe(true);
    expect(results.some(r => r.url === 'https://example.com/valid')).toBe(true);
  });
});

describe('fetchPageReadable', () => {
  const mockAgent = new MockAgent();

  beforeAll(async () => {
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
  });

  afterAll(async () => {
    await mockAgent.close();
  });

  it('extracts content and title when Readability succeeds', async () => {
    const html = `
      <html><head><title>My Title</title></head>
      <body>
        <article><h1>Headline</h1><p>Article body text here.</p></article>
      </body></html>
    `;
    const origin = mockAgent.get('https://readable.example');
    origin.intercept({ path: '/article', method: 'GET' }).reply(200, html, {
      headers: { 'Content-Type': 'text/html' }
    });

    const page = await fetchPageReadable('https://readable.example/article');
    expect(page.content).toContain('Article body text');
    expect(page.title).toBeTruthy();
  });

  it('falls back to body.textContent when Readability returns null', async () => {
    // A minimal non-article page that Readability likely can't parse meaningfully
    const html = `<html><head></head><body><p>Just some plain text.</p></body></html>`;
    const origin = mockAgent.get('https://readable.example');
    origin.intercept({ path: '/plain', method: 'GET' }).reply(200, html, {
      headers: { 'Content-Type': 'text/html' }
    });

    const page = await fetchPageReadable('https://readable.example/plain');
    expect(typeof page.content).toBe('string');
  });

  it('rejects non-https URL', async () => {
    await expect(fetchPageReadable('http://example.com/page')).rejects.toThrow('Only https:');
  });

  it('returns content as empty string when body is empty', async () => {
    const html = `<html><head></head><body></body></html>`;
    const origin = mockAgent.get('https://readable.example');
    origin.intercept({ path: '/empty', method: 'GET' }).reply(200, html, {
      headers: { 'Content-Type': 'text/html' }
    });

    const page = await fetchPageReadable('https://readable.example/empty');
    expect(page.content).toBe('');
  });
});

