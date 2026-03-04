import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { fetchPageReadable, searchWebDuckDuckGo, validateUrl, isPrivateIp } from '../src/server.js';

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

  it('throws for private IP resolved by DNS', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }] as never);
    await expect(validateUrl('https://internal.example.com')).rejects.toThrow(
      'private/internal'
    );
  });

  it('allows valid https URL resolving to public IP', async () => {
    await expect(validateUrl('https://example.com')).resolves.toBeUndefined();
  });
});

