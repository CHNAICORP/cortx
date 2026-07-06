/**
 * 网络工具 — web_search + web_fetch (node:https 支持代理)
 *
 * 设计参照 Claude Code 的 WebSearch / WebFetch:
 *   web_search → 找页面 (标题+URL+摘要)，支持域名过滤、结果去重
 *   web_fetch  → 读内容 (HTML→可读文本)，支持截断控制、元数据提取
 *
 * Harness Agent 设计哲学:
 *   1. 工具即原语 — 搜索和抓取职责分离，LLM 自主决定何时用哪个
 *   2. LLM 可控 — 关键参数暴露给 LLM (allowed_domains, max_chars 等)
 *   3. 优雅降级 — 多引擎 fallback 链，每步失败有清晰日志
 *   4. 结构化输出 — 结果格式统一，便于 LLM 推理
 *   5. 可观测性 — 每条结果标注来源引擎
 */
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { checkSsrf } from '../core/policy.js';
import * as https from "node:https";
import * as http from "node:http";

async function httpRequest(url: string, method = 'GET', body?: string, timeout = 10000, extraHeaders: Record<string, string> = {}, maxRedirects = 5): Promise<string> {
  const reqUrl = new URL(url);
  // SSRF check via policy engine (includes DNS resolution + CIDR matching)
  const [ssrfOk, ssrfMsg] = await checkSsrf(reqUrl.hostname);
  if (!ssrfOk) {
    throw new Error(ssrfMsg);
  }
  return new Promise((resolve, reject) => {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    let hostname = reqUrl.hostname;
    let port = reqUrl.port || (reqUrl.protocol === 'https:' ? 443 : 80);
    let path = reqUrl.pathname + reqUrl.search;
    if (proxy) {
      try {
        const pu = new URL(proxy);
        hostname = pu.hostname;
        port = parseInt(pu.port) || (pu.protocol === 'https:' ? 443 : 80);
        path = url;
      } catch { /* 代理 URL 解析失败，直连 */ }
    }
    const mod = (proxy ? http : (reqUrl.protocol === 'https:' ? https : http));
    const options: Record<string, unknown> = {
      hostname, port, path, method, timeout,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Host': reqUrl.hostname,
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...extraHeaders,
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
      if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
        const loc = res.headers.location;
        try {
          const locUrl = new URL(loc, url);
          // 仅跟随同域名重定向，限制最大深度避免无限循环
          if (locUrl.hostname === reqUrl.hostname) {
            if (maxRedirects <= 0) {
              reject(new Error("超过最大重定向次数 (5)"));
              return;
            }
            resolve(httpRequest(locUrl.href, method, body, timeout, extraHeaders, maxRedirects - 1));
            return;
          }
        } catch { /* 继续 */ }
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error('timeout')); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 域名过滤 ──
function filterDomains(url: string, allowed?: string[], blocked?: string[]): boolean {
  try {
    const host = (new URL(url).hostname || "").toLowerCase();
    if (blocked) {
      for (const d of blocked) {
        if (host === d.toLowerCase() || host.endsWith("." + d.toLowerCase())) return false;
      }
    }
    if (allowed && allowed.length > 0) {
      for (const d of allowed) {
        if (host === d.toLowerCase() || host.endsWith("." + d.toLowerCase())) return true;
      }
      return false;
    }
    return true;
  } catch { return true; }
}

// ── 结果去重 ──
function dedupResults(results: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  const deduped: SearchItem[] = [];
  for (const item of results) {
    let key: string;
    try {
      const p = new URL(item.url);
      // 按 hostname + pathname 去重（忽略尾部斜杠和 query 参数）
      key = (p.hostname || "").toLowerCase() + (p.pathname || "").replace(/\/$/, "").toLowerCase();
    } catch {
      key = item.url.toLowerCase();
    }
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

// ── 搜索结果类型 ──
interface SearchItem { title: string; url: string; snippet: string }

// ── 格式化搜索结果 ──
function formatSearchResults(query: string, engine: string, results: SearchItem[]): string {
  if (!results.length) return "";
  const out: string[] = [`搜索 "${query}" via ${engine} (${results.length} 条):\n`];
  results.forEach((r, i) => {
    out.push(`  [${i + 1}] ${r.title.slice(0, 120)}`);
    out.push(`      🔗 ${r.url}`);
    if (r.snippet) out.push(`      ${r.snippet.slice(0, 200)}`);
    out.push("");
  });
  return out.join("\n");
}

// ── 搜索缓存 ──
const _searchCache = new Map<string, string>();
const SEARCH_CACHE_MAX = 50;

// ── 联网搜索 (多引擎) ──
registry.register(
  "联网搜索网页 — 返回标题、URL 和摘要。找到页面后可用 web_fetch 读取全文。\n"
    + "参数:\n"
    + "  query           搜索关键词 (必填)\n"
    + "  allowed_domains 限定搜索域名，逗号分隔 (可选，如 'github.com,stackoverflow.com')\n"
    + "  max_results     最大结果数 (可选，默认 5)\n"
    + "用法: web_search(query=\"Python 3.13 新特性\")\n"
    + "      web_search(query=\"React hooks\", allowed_domains=\"reactjs.org,github.com\")",
  RiskLevel.SAFE, Capability.NET_SEARCH,
  { workDir: "string", query: "string", allowed_domains: "string", max_results: "integer" },
  async function web_search(_workDir: string, args: Record<string, unknown>): Promise<string> {
    const query = String(args["query"]);
    const encoded = encodeURIComponent(query);
    const allowedDomainsStr = String(args["allowed_domains"] || "");
    const allowed = allowedDomainsStr ? allowedDomainsStr.split(",").map(d => d.trim()).filter(Boolean) : undefined;
    const maxResultsArg = Number(args["max_results"] || 0);

    // 从 settings.json 读取搜索配置
    let wsCfg: Record<string, unknown> = {};
    try {
      const { loadSettings } = await import("../config.js");
      wsCfg = (loadSettings().web_search as Record<string, unknown>) || {};
    } catch { /* use defaults */ }
    const provider = String(wsCfg.provider || "duckduckgo");
    const n = maxResultsArg > 0 ? maxResultsArg : Number(wsCfg.max_results || 5);
    const timeout = Number(wsCfg.timeout || 10) * 1000;
    const blocked = ["bing.com", "duckduckgo.com", "google.com", "baidu.com", "csdn.net"];

    // ── 检查缓存 ──
    const cacheKey = `${query}|${allowed?.join(",") || ""}|${n}`;
    if (_searchCache.has(cacheKey)) {
      return _searchCache.get(cacheKey)! + "\n[缓存命中]";
    }

    let rawResults: SearchItem[] = [];
    let engineUsed = "";

    // ── Brave Search API ──
    if (provider === "brave" && wsCfg.brave_api_key) {
      try {
        const apiUrl = `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${n * 2}`;
        const data = await apiGet(apiUrl, {
          "X-Subscription-Token": String(wsCfg.brave_api_key),
          "Accept-Encoding": "gzip",
        }, timeout);
        const json = JSON.parse(data);
        for (const item of ((json.web?.results || []) as Array<Record<string, string>>).slice(0, n * 2)) {
          if (item.title && item.url) {
            rawResults.push({ title: item.title, url: item.url, snippet: item.description || "" });
          }
        }
        engineUsed = "Brave";
      } catch { /* fall through */ }
    }

    // ── Tavily Search API ──
    if (!rawResults.length && provider === "tavily" && wsCfg.tavily_api_key) {
      try {
        const apiUrl = "https://api.tavily.com/search";
        const body = JSON.stringify({
          api_key: String(wsCfg.tavily_api_key), query, max_results: n * 2, search_depth: "basic",
        });
        const data = await apiPost(apiUrl, body, timeout);
        const json = JSON.parse(data);
        for (const item of ((json.results || []) as Array<Record<string, string>>).slice(0, n * 2)) {
          if (item.title && item.url) {
            rawResults.push({ title: item.title, url: item.url, snippet: item.content || "" });
          }
        }
        engineUsed = "Tavily";
      } catch { /* fall through */ }
    }

    // ── SerpAPI (Google) ──
    if (!rawResults.length && provider === "serpapi" && wsCfg.serpapi_api_key) {
      try {
        const apiUrl = `https://serpapi.com/search?q=${encoded}&api_key=${wsCfg.serpapi_api_key}&num=${n * 2}&engine=google`;
        const data = await httpRequest(apiUrl, 'GET', undefined, timeout);
        const json = JSON.parse(data);
        for (const item of ((json.organic_results || []) as Array<Record<string, string>>).slice(0, n * 2)) {
          if (item.title && item.link) {
            rawResults.push({ title: item.title, url: item.link, snippet: item.snippet || "" });
          }
        }
        engineUsed = "SerpAPI";
      } catch { /* fall through */ }
    }

    // ── DuckDuckGo Instant Answer API (JSON — 最快) ──
    if (!rawResults.length) {
      try {
        const html = await httpRequest(
          `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
          'GET', undefined, 8000
        );
        const data = JSON.parse(html);
        if (data.AbstractText && data.AbstractText.trim()) {
          rawResults.push({ title: data.Heading || query, url: data.AbstractURL || "", snippet: data.AbstractText.slice(0, 300) });
        }
        for (const t of (data.RelatedTopics || [])) {
          if (t.Text && t.FirstURL) {
            rawResults.push({ title: t.Text.slice(0, 120), url: t.FirstURL, snippet: t.Text || "" });
          }
        }
        engineUsed = "DuckDuckGo";
      } catch { /* fall through */ }
    }

    // ── DuckDuckGo Lite (HTML scraping — fallback) ──
    if (!rawResults.length) {
      try {
        const body = new URLSearchParams({ q: query }).toString();
        const html = await httpRequest('https://lite.duckduckgo.com/lite/', 'POST', body, 8000);
        // DDG Lite: nofollow links
        let linkRe = /<a[^>]*?rel=["']nofollow["'][^>]*?href=["']([^"']+)["'][^>]*?>(.*?)<\/a>/gi;
        let match: RegExpExecArray | null;
        while ((match = linkRe.exec(html)) !== null) {
          const u = match[1], title = match[2].replace(/<[^>]+>/g, '').trim();
          if (!title || u.includes('duckduckgo.com')) continue;
          const restIdx = match.index + match[0].length;
          const snippetM = /<span[^>]*?class=["']snippet["'][^>]*?>(.*?)<\/span>/i.exec(html.slice(restIdx, restIdx + 2000));
          const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, '').trim() : '';
          rawResults.push({ title, url: u, snippet });
        }
        // Fallback: DDG Lite table format
        if (!rawResults.length) {
          const tdRe = /<td[^>]*>\s*<a[^>]*?href=["']([^"']+)["'][^>]*?>(.*?)<\/a>/gi;
          while ((match = tdRe.exec(html)) !== null) {
            const u = match[1], title = match[2].replace(/<[^>]+>/g, '').trim();
            if (!title || u.includes('duckduckgo.com') || u === '/lite/') continue;
            rawResults.push({ title, url: u, snippet: "" });
          }
        }
        engineUsed = "DuckDuckGo Lite";
      } catch { /* fall through */ }
    }

    // ── Bing Web Search (HTML scraping — final fallback) ──
    if (!rawResults.length) {
      try {
        const bingUrl = `https://cn.bing.com/search?q=${encoded}&setlang=zh-cn`;
        const html = await httpRequest(bingUrl, 'GET', undefined, timeout);
        const h2Re = /<h2[^>]*>\s*<a[^>]*?href=["']([^"']+)["'][^>]*?>(.*?)<\/a>\s*<\/h2>/gi;
        let match: RegExpExecArray | null;
        while ((match = h2Re.exec(html)) !== null) {
          const u = match[1], title = match[2].replace(/<[^>]+>/g, '').trim().replace(/&amp;/g, '&');
          if (!title || u.includes('bing.com')) continue;
          const restIdx = match.index + match[0].length;
          const snippetM = /<p[^>]*>(.*?)<\/p>/i.exec(html.slice(restIdx, restIdx + 2000));
          const snippet = snippetM ? snippetM[1].replace(/<[^>]+>/g, '').trim().replace(/&ensp;/g, ' ').replace(/&#0183;/g, ' • ') : '';
          rawResults.push({ title, url: u, snippet });
        }
        engineUsed = "Bing";
      } catch { /* all search strategies failed */ }
    }

    // ── 后处理: 域名过滤 + 去重 + 截断 ──
    let filtered = rawResults.filter(r => filterDomains(r.url, allowed, allowed ? undefined : blocked));
    if (!filtered.length && rawResults.length) filtered = rawResults;
    filtered = dedupResults(filtered).slice(0, n);

    if (!filtered.length) {
      return `(未找到与 "${query}" 相关的结果。请尝试:\n`
        + `1. 使用更通用的搜索词\n`
        + `2. 在 settings.json 中配置 web_search.provider 为 brave/serpapi/tavily 并填入 API key\n`
        + `3. 检查网络连接是否正常)`;
    }

    const output = formatSearchResults(query, engineUsed, filtered);

    // ── 写入缓存 ──
    if (_searchCache.size >= SEARCH_CACHE_MAX) _searchCache.clear();
    _searchCache.set(cacheKey, output);

    return output;
  },
);

// ── API helpers ──
async function apiGet(url: string, extraHeaders: Record<string, string>, timeout: number): Promise<string> {
  return httpRequest(url, 'GET', undefined, timeout, extraHeaders);
}

async function apiPost(url: string, body: string, timeout: number): Promise<string> {
  return httpRequest(url, 'POST', body, timeout);
}

// ── 增强版 HTML → 可读文本 ──
function htmlToReadable(html: string): string {
  // 移除 script/style/nav/footer/aside/header 标签及内容
  for (const tag of ['script', 'style', 'nav', 'footer', 'aside', 'header', 'noscript', 'iframe', 'svg']) {
    html = html.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
  }
  // 移除常见广告/模板 class
  html = html.replace(/<div[^>]*class=["'][^"']*(?:ad|banner|cookie|sidebar|menu|navigation|comment|share|social|related|recommend)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
  // HTML → 文本
  let text = html
    .replace(/<\/?(div|p|h[1-6]|li|tr|br|article|section|blockquote|pre|code)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&ensp;/g, " ").replace(/&mdash;/g, "—").replace(/&hellip;/g, "…");
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  // 移除空行和行首尾空格
  const lines = text.split("\n").map(l => l.trim()).filter(l => l);
  return lines.join("\n");
}

// ── 提取页面元数据 ──
function extractPageMetadata(html: string): { title: string; description: string } {
  const meta = { title: "", description: "" };
  const titleM = html.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleM) meta.title = titleM[1].replace(/<[^>]+>/g, '').trim().slice(0, 200);
  const descM = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  if (descM) meta.description = descM[1].trim().slice(0, 300);
  const ogM = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  if (ogM && !meta.title) meta.title = ogM[1].trim().slice(0, 200);
  return meta;
}

// ── 网页抓取缓存 ──
const _fetchCache = new Map<string, [number, string]>();
const FETCH_CACHE_MAX = 20;
const FETCH_CACHE_TTL = 300000; // 5 分钟

// ── 抓取网页全文 ──
registry.register(
  "抓取网页全文并提取可读文本。适合读取 web_search 找到的具体页面。\n"
    + "参数:\n"
    + "  url       目标网址 (必填，须以 http:// 或 https:// 开头)\n"
    + "  max_chars 最大返回字符数 (可选，默认 4000，最大 20000)\n"
    + "用法: web_fetch(url=\"https://docs.python.org/3/whatsnew/3.13.html\")\n"
    + "      web_fetch(url=\"https://long-article.com\", max_chars=8000)",
  RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string", max_chars: "integer" },
  async function web_fetch(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    if (!/^https?:\/\//i.test(url)) return "(x) URL 须以 http:// 或 https:// 开头";
    const maxCharsArg = Number(args["max_chars"] || 0);
    const limit = Math.min(maxCharsArg > 0 ? maxCharsArg : 4000, 20000);

    // ── 检查缓存 ──
    const cacheKey = `${url}|${limit}`;
    const cached = _fetchCache.get(cacheKey);
    if (cached && Date.now() - cached[0] < FETCH_CACHE_TTL) {
      return cached[1] + "\n[缓存命中]";
    }

    try {
      const html = await httpRequest(url, 'GET', undefined, 15000);
      const ct = html.startsWith("{") ? "application/json" : "text/html"; // 简化判断

      let text: string;
      let header: string;

      if (ct === "text/html" || /<html|<!doctype/i.test(html)) {
        const meta = extractPageMetadata(html);
        text = htmlToReadable(html);
        const headerParts = [`--- ${url} ---`];
        if (meta.title) headerParts.push(`标题: ${meta.title}`);
        if (meta.description) headerParts.push(`摘要: ${meta.description}`);
        header = headerParts.join("\n") + "\n\n";
      } else {
        text = html;
        header = `--- ${url} ---\n[Content-Type: ${ct}]\n\n`;
      }

      if (!text.trim()) return `--- ${url} ---\n(无有效文本)`;

      // ── 智能截断: 保留开头和结尾 ──
      if (text.length > limit) {
        const keepHead = Math.floor(limit * 0.8);
        const keepTail = Math.floor(limit * 0.15);
        text = text.slice(0, keepHead) + `\n\n[... 已截断，原文 ${text.length} 字符 ...]\n\n` + text.slice(-keepTail);
      }

      const result = header + text;

      // ── 写入缓存 ──
      if (_fetchCache.size >= FETCH_CACHE_MAX) _fetchCache.clear();
      _fetchCache.set(cacheKey, [Date.now(), result]);

      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return `(x) 抓取失败: ${msg} — ${url}`;
    }
  },
);

// ── HTTP 请求工具 (从 file.ts 移入，与 web_search/web_fetch 同属网络工具) ──
registry.register("HTTP请求", RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string", method: "string", body: "string", headers: "string" },
  async function http_request(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]); const method = String(args["method"] || "GET");
    try {
      // SSRF check before making the request
      if (/^https?:\/\//i.test(url)) {
        const [ok, reason] = await checkSsrf(url);
        if (!ok) return `(x) ${reason}`;
      }
      const resp = await fetch(url, { method, body: args["body"] ? String(args["body"]) : undefined });
      return `HTTP ${resp.status}\n${(await resp.text()).slice(0, 2000)}`;
    } catch (e) { return `(x) ${e}`; }
  },
);
