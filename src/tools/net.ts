/**
 * 网络工具 — web_search + web_fetch (node:https 支持代理)
 *
 * 设计参照 Claude Code:
 *   WebSearch → 找页面 (标题+URL+摘要)
 *   WebFetch  → 读内容 (HTML→文本，截断至 8KB)
 *
 * 多引擎 fallback (由 settings.json 中 web_search.provider 决定):
 *   duckduckgo → DuckDuckGo API → DuckDuckGo Lite (免费, 默认)
 *   brave      → Brave Search API (付费, 更高精准度)
 *   serpapi    → SerpAPI / Google (付费, 结果最丰富)
 *   tavily     → Tavily Search API (付费, AI 优化摘要)
 */
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import * as https from "node:https";
import * as http from "node:http";
import * as dns from "node:dns";

// ── SSRF 防护 (内网 CIDR 黑名单) ──
const SSRF_BLOCKED_NETS = [
  /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^127\./, /^169\.254\./, /^0\.0\.0\./,
];

function isPrivateHost(hostname: string): boolean {
  // IPv6 loopback / link-local
  if (hostname === "::1" || hostname === "localhost" || hostname.startsWith("fe80:")) return true;
  // IPv4-mapped IPv6
  const v4m = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4m) hostname = v4m[1];
  for (const net of SSRF_BLOCKED_NETS) {
    if (net.test(hostname)) return true;
  }
  return false;
}

function httpRequest(url: string, method = 'GET', body?: string, timeout = 10000, extraHeaders: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const reqUrl = new URL(url);

    // SSRF 防护
    if (isPrivateHost(reqUrl.hostname)) {
      return reject(new Error(`SSRF 防护: 禁止访问内网地址 ${reqUrl.hostname}`));
    }

    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    let hostname = reqUrl.hostname;
    let port = reqUrl.port || (reqUrl.protocol === 'https:' ? 443 : 80);
    let path = reqUrl.pathname + reqUrl.search;
    // 如果有代理，通过代理连接
    if (proxy) {
      try {
        const pu = new URL(proxy);
        hostname = pu.hostname;
        port = parseInt(pu.port) || (pu.protocol === 'https:' ? 443 : 80);
        path = url; // 完整 URL 作为 path
      } catch { /* 代理 URL 解析失败，直连 */ }
    }
    const mod = (proxy ? http : (reqUrl.protocol === 'https:' ? https : http));
    const options: Record<string, unknown> = {
      hostname, port, path, method, timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CortexAgent/1.0)',
        'Host': reqUrl.hostname,  // 重要：保留原始 Host
        'Accept': 'text/html,application/json,*/*',
        ...extraHeaders, // Merge extra headers (e.g., API keys)
      } as Record<string, string>,
    };
    if (body) {
      const existingHeaders = options.headers as Record<string, string>;
      options.headers = {
        ...existingHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body).toString(),
      };
    }
    const req = mod.request(options, (res) => {
      // 跟随重定向 (同 host) — check SSRF on redirect too
      if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        const loc = res.headers.location;
        try {
          const locUrl = new URL(loc, url);
          if (isPrivateHost(locUrl.hostname)) {
            reject(new Error(`SSRF 防护: 重定向到内网地址 ${locUrl.hostname}`));
            return;
          }
          if (locUrl.hostname === reqUrl.hostname) {
            resolve(httpRequest(locUrl.href, method, body, timeout, extraHeaders));
            return;
          }
        } catch { /* 继续 */ }
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── HTML → 可读文本 ──
function htmlToText(html: string): string {
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(div|p|h[1-6]|li|tr|article|section|header|footer)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

// ── 联网搜索 (多引擎) ──
registry.register(
  "联网搜索网页 — 返回标题、URL 和摘要。找到页面后可用 web_fetch 读取全文。\n"
    + "支持搜索引擎: duckduckgo(免费默认) | brave | serpapi | tavily。在 settings.json 中配置 web_search.provider 和对应 API key。",
  RiskLevel.SAFE, Capability.NET_SEARCH,
  { workDir: "string", query: "string" },
  async function web_search(_workDir: string, args: Record<string, unknown>): Promise<string> {
    const query = String(args["query"]);
    const encoded = encodeURIComponent(query);

    // 从 settings.json 读取搜索配置
    let wsCfg: Record<string, unknown> = {};
    try {
      const { loadSettings } = await import("../config.js");
      wsCfg = (loadSettings().web_search as Record<string, unknown>) || {};
    } catch { /* use defaults */ }
    const provider = String(wsCfg.provider || "duckduckgo");
    const maxResults = Number(wsCfg.max_results || 5);
    const timeout = Number(wsCfg.timeout || 10) * 1000;

    // ── Brave Search API ──
    if (provider === "brave" && wsCfg.brave_api_key) {
      try {
        const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`;
        const data = await apiGet(apiUrl, {
          "X-Subscription-Token": String(wsCfg.brave_api_key),
          "Accept-Encoding": "gzip",
        }, timeout);
        const json = JSON.parse(data);
        const results: string[] = [];
        for (const item of ((json.web?.results || []) as Array<Record<string, string>>).slice(0, maxResults)) {
          if (item.title && item.url) {
            results.push(`[${results.length + 1}] ${item.title}\n    URL: ${item.url}`);
            if (item.description) results.push(`    ${item.description.slice(0, 200)}`);
          }
        }
        if (results.length > 0) return `搜索 "${query}" via Brave (${results.length} 条):\n\n${results.join("\n\n")}`;
      } catch { /* fall through */ }
    }

    // ── Tavily Search API ──
    if (provider === "tavily" && wsCfg.tavily_api_key) {
      try {
        const apiUrl = "https://api.tavily.com/search";
        const body = JSON.stringify({
          api_key: String(wsCfg.tavily_api_key), query, max_results: maxResults, search_depth: "basic",
        });
        const data = await apiPost(apiUrl, body, timeout);
        const json = JSON.parse(data);
        const results: string[] = [];
        for (const item of ((json.results || []) as Array<Record<string, string>>).slice(0, maxResults)) {
          if (item.title && item.url) {
            results.push(`[${results.length + 1}] ${item.title}\n    URL: ${item.url}`);
            if (item.content) results.push(`    ${item.content.slice(0, 200)}`);
          }
        }
        if (results.length > 0) return `搜索 "${query}" via Tavily (${results.length} 条):\n\n${results.join("\n\n")}`;
      } catch { /* fall through */ }
    }

    // ── SerpAPI (Google) ──
    if (provider === "serpapi" && wsCfg.serpapi_api_key) {
      try {
        const apiUrl = `https://serpapi.com/search?q=${encoded}&api_key=${wsCfg.serpapi_api_key}&num=${maxResults}&engine=google`;
        const data = await httpRequest(apiUrl, 'GET', undefined, timeout);
        const json = JSON.parse(data);
        const results: string[] = [];
        for (const item of ((json.organic_results || []) as Array<Record<string, string>>).slice(0, maxResults)) {
          const title = item.title, url = item.link;
          if (title && url) {
            results.push(`[${results.length + 1}] ${title}\n    URL: ${url}`);
            if (item.snippet) results.push(`    ${item.snippet.slice(0, 200)}`);
          }
        }
        if (results.length > 0) return `搜索 "${query}" via SerpAPI (${results.length} 条):\n\n${results.join("\n\n")}`;
      } catch { /* fall through */ }
    }

    // ── DuckDuckGo (免费默认 / fallback) ──
    // Strategy 1: DuckDuckGo Instant Answer API (JSON — 最快)
    try {
      const html = await httpRequest(
        `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
        'GET', undefined, 8000
      );
      const data = JSON.parse(html);
      const results: string[] = [];

      // Abstract (definition/instant answer)
      if (data.AbstractText && data.AbstractText.trim()) {
        results.push(`📖 ${data.AbstractText.slice(0, 300)}\n    URL: ${data.AbstractURL || ''}`);
      }

      // Related topics
      const topics = data.RelatedTopics || [];
      for (let i = 0; i < Math.min(topics.length, maxResults); i++) {
        const t = topics[i];
        if (t.Text && t.FirstURL) {
          results.push(`[${i + 1}] ${t.Text.slice(0, 120)}\n    URL: ${t.FirstURL}`);
        }
      }

      if (results.length > 0) {
        return `搜索 "${query}" (${results.length} 条):\n\n${results.join("\n\n")}`;
      }
    } catch {
      // API failed → fall through to Lite HTML
    }

    // Strategy 2: DuckDuckGo Lite (HTML scraping — fallback)
    try {
      const body = new URLSearchParams({ q: query }).toString();
      const html = await httpRequest('https://lite.duckduckgo.com/lite/', 'POST', body, 8000);
      const results: string[] = [];

      // Parse <a rel="nofollow" href="...">title</a> + <span class="snippet">...</span>
      const linkRe = /<a[^>]*?rel=["']nofollow["'][^>]*?href=["']([^"']+)["'][^>]*?>(.*?)<\/a>/gi;
      let match;
      while ((match = linkRe.exec(html)) !== null) {
        const u = match[1], title = match[2].replace(/<[^>]+>/g, '').trim();
        if (!title || u.includes('duckduckgo.com')) continue;
        // Look for snippet after this link
        const restIdx = match.index + match[0].length;
        const snippetM = /<span[^>]*?class=["']snippet["'][^>]*?>(.*?)<\/span>/i.exec(
          html.slice(restIdx, restIdx + 2000)
        );
        const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, '').trim() : '';
        results.push(`[${results.length + 1}] ${title.slice(0, 120)}\n    URL: ${u}${snippet ? `\n    ${snippet.slice(0, 150)}` : ''}`);
        if (results.length >= maxResults) break;
      }

      if (results.length > 0) {
        return `搜索 "${query}" (${results.length} 条):\n\n${results.join("\n\n")}`;
      }
    } catch {
      // Both strategies failed
    }

    return `(未找到与 "${query}" 相关的结果)`;
  },
);

// ── API helpers (with proper headers) ──
async function apiGet(url: string, extraHeaders: Record<string, string>, timeout: number): Promise<string> {
  return httpRequest(url, 'GET', undefined, timeout, extraHeaders);
}

async function apiPost(url: string, body: string, timeout: number): Promise<string> {
  // Use httpRequest via POST — Tavily accepts x-www-form-urlencoded too
  return httpRequest(url, 'POST', body, timeout);
}

// ── 抓取网页全文 ──
registry.register(
  "抓取网页全文并提取可读文本。适合读取 web_search 找到的具体页面。",
  RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string" },
  async function web_fetch(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    if (!/^https?:\/\//i.test(url)) return "(x) URL 须以 http:// 或 https:// 开头";
    try {
      const html = await httpRequest(url, 'GET', undefined, 10000);
      let text = htmlToText(html);
      if (text.length > 8000) text = text.slice(0, 8000) + `\n\n[...已截断，原文 ${text.length} 字符]`;
      return `--- ${url} ---\n${text || "(无有效文本)"}`;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `(x) 抓取失败: ${msg}`;
    }
  },
);
