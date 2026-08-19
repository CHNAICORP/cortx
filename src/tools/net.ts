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
import { truncateMiddle, USER_AGENT, USER_AGENT_SHORT, PRODUCT_NAME, needsProxy, getProxyUrl } from '../core/constants.js';
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
    // 智能代理：海外域名走代理（加速防超时），国内域名直连
    const proxy = needsProxy(url) ? getProxyUrl() : null;
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
        'User-Agent': USER_AGENT,
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
        // 调用方已指定 Content-Type（如 JSON API）则不覆盖；默认 urlencoded
        ...(existingHeaders['Content-Type'] ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
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
    if (r.snippet) {
      const maxLen = 2000;
      const snip = r.snippet.slice(0, maxLen);
      out.push(`      ${snip}${r.snippet.length > maxLen ? " [...已截断]" : ""}`);
    }
    out.push("");
  });
  return out.join("\n");
}

// ── 搜索缓存 ──
const _searchCache = new Map<string, string>();
const SEARCH_CACHE_MAX = 50;

// ── 联网搜索 (多引擎) ──
registry.register(
  "联网搜索网页 — 返回标题、URL 和富内容（前2条自动抓取页面正文）。多数情况搜索结果已包含足够信息，无需再 web_fetch。\n"
    + "参数:\n"
    + "  query           搜索关键词 (必填)\n"
    + "  allowed_domains 限定搜索域名，逗号分隔 (可选，如 'github.com,stackoverflow.com')\n"
    + "  max_results     最大结果数 (可选，默认 15)\n"
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
    const provider = String(wsCfg.provider || "bing");
    const n = maxResultsArg > 0 ? maxResultsArg : Number(wsCfg.max_results || 15);
    const timeout = Number(wsCfg.timeout || 8) * 1000;
    const blocked = ["bing.com", "duckduckgo.com", "google.com", "baidu.com", "csdn.net"];

    // ── 检查缓存 ──
    const cacheKey = `${query}|${allowed?.join(",") || ""}|${n}`;
    if (_searchCache.has(cacheKey)) {
      return _searchCache.get(cacheKey)! + "\n[缓存命中]";
    }

    let rawResults: SearchItem[] = [];
    let engineUsed = "";
    // 引擎尝试链：配置的 API 引擎失败回退时，在结果中可见完整路径（如 "Zhipu→Bing"）
    const triedEngines: string[] = [];
    const noteFallback = (name: string) => { triedEngines.push(name); };

    // ── 智谱联网搜索（国内直连，0.01元/次，用户配了 key 才用）──
    if (provider === "zhipu" && wsCfg.zhipu_api_key) {
      try {
        const data = await httpRequest(
          "https://open.bigmodel.cn/api/paas/v4/web_search",
          "POST",
          JSON.stringify({ search_engine: "search_std", search_query: query, count: n, content_size: "medium" }),
          timeout,
          { "Authorization": `Bearer ${wsCfg.zhipu_api_key}`, "Content-Type": "application/json" },
        );
        const json = JSON.parse(data);
        if (json.error) throw new Error(`智谱 API 错误 ${json.error.code || ""}: ${json.error.message || ""}`);
        for (const item of ((json.search_result || []) as Array<Record<string, string>>).slice(0, n)) {
          // title 兜底（个别条目缺 title），link 缺失才跳过
          const link = item.link || item.url || "";
          if (link) {
            rawResults.push({ title: item.title || item.media || "(未命名)", url: link, snippet: item.content || "" });
          }
        }
        // 智谱已返回结果（哪怕 1 条）就使用，不回退 Bing
        if (rawResults.length > 0) {
          engineUsed = "Zhipu";
        } else if ((json.search_result || []).length > 0) {
          // 返回了条目但全部缺 link — 罕见，记录后回退
          noteFallback("Zhipu"); console.error(`[web_search] Zhipu 返回 ${(json.search_result || []).length} 条但均缺 link，回退内置`);
        }
      } catch (e) { noteFallback("Zhipu"); console.error("[web_search] Zhipu 引擎失败，回退内置: " + (e instanceof Error ? e.message : String(e))); }
    }

    // ── Exa 搜索（海外，注册送 $20 额度）──
    if (!rawResults.length && provider === "exa" && wsCfg.exa_api_key) {
      try {
        const data = await httpRequest(
          "https://api.exa.ai/search",
          "POST",
          JSON.stringify({ query, numResults: n, contents: { text: { maxCharacters: 1000 } } }),
          timeout,
          { "x-api-key": String(wsCfg.exa_api_key), "Content-Type": "application/json" },
        );
        const json = JSON.parse(data);
        for (const item of ((json.results || []) as Array<Record<string, string>>).slice(0, n)) {
          if (item.title && item.url) {
            rawResults.push({ title: item.title, url: item.url, snippet: item.text || item.summary || "" });
          }
        }
        engineUsed = "Exa";
      } catch (e) { noteFallback("Exa"); console.error("[web_search] Exa 引擎失败，回退内置: " + (e instanceof Error ? e.message : String(e))); }
    }

    // ── Firecrawl 搜索（海外，1000次/月免费）──
    if (!rawResults.length && provider === "firecrawl" && wsCfg.firecrawl_api_key) {
      try {
        const data = await httpRequest(
          "https://api.firecrawl.dev/v1/search",
          "POST",
          JSON.stringify({ query, limit: n }),
          timeout,
          { "Authorization": `Bearer ${wsCfg.firecrawl_api_key}`, "Content-Type": "application/json" },
        );
        const json = JSON.parse(data);
        for (const item of ((json.data || []) as Array<Record<string, string>>).slice(0, n)) {
          if (item.title && item.url) {
            rawResults.push({ title: item.title, url: item.url, snippet: item.description || "" });
          }
        }
        engineUsed = "Firecrawl";
      } catch (e) { noteFallback("Firecrawl"); console.error("[web_search] Firecrawl 引擎失败，回退内置: " + (e instanceof Error ? e.message : String(e))); }
    }

    // ── Brave Search API（用户配了 key 才用）──
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

    // ── Bing (ensearch=1 对中英文搜索质量都最好) ──
    if (!rawResults.length) {
      const searchBing = async (searchUrl: string): Promise<SearchItem[]> => {
        try {
          const resp = await fetch(searchUrl, {
            signal: AbortSignal.timeout(5000),
            headers: { "User-Agent": USER_AGENT_SHORT },
          });
          const html = await resp.text();
          const blockRe = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
          const items: SearchItem[] = [];
          let blockMatch: RegExpExecArray | null;
          while ((blockMatch = blockRe.exec(html)) !== null && items.length < n) {
            const block = blockMatch[1];
            const h2 = block.match(/<h2[^>]*><a[^>]*>(.*?)<\/a>/i);
            const title = h2 ? h2[1].replace(/<[^>]+>/g, '').trim().replace(/&amp;/g, '&') : "";
            const cite = block.match(/<cite[^>]*>(.*?)<\/cite>/i);
            const rawUrl = cite ? cite[1].replace(/<[^>]+>/g, '').trim() : "";
            const url = rawUrl.startsWith('http') ? rawUrl.split('›')[0].trim().replace(/\s+/g, '') : 'https://' + rawUrl.split('›')[0].trim().replace(/\s+/g, '');
            const fullText = block
              .replace(/<[^>]+>/g, ' ')
              .replace(/&ensp;/g, ' ').replace(/&#0183;/g, ' • ').replace(/&amp;/g, '&')
              .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ').trim();
            let snippet = fullText;
            if (title) snippet = snippet.replace(title, '').trim();
            if (rawUrl) snippet = snippet.replace(rawUrl, '').trim();
            if (snippet.length > 600) snippet = snippet.slice(0, 600) + ' [...]';
            if (title && url) items.push({ title, url, snippet });
          }
          return items;
        } catch { return []; }
      };
      // ensearch=1 对中文搜索质量最好（避免 cn.bing.com 拆词问题）
      rawResults = await searchBing(`https://cn.bing.com/search?q=${encoded}&ensearch=1&setlang=en`);
      engineUsed = triedEngines.length > 0 ? triedEngines.join("→") + "→Bing" : "Bing";
    }

    // ── DuckDuckGo Instant Answer API (JSON — 备用，需代理) ──
    if (!rawResults.length) {
      try {
        const html = await httpRequest(
          `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
          'GET', undefined, 5000
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
        const html = await httpRequest('https://lite.duckduckgo.com/lite/', 'POST', body, 5000);
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

    // ── 质量过滤：移除日历页面、通用列表页等低质量结果 ──
    rawResults = rawResults.filter(r => {
      const t = r.title.toLowerCase(), u = r.url.toLowerCase();
      if (/calendar|major events of|pop culture|ปฏิทิน/i.test(t)) return false;
      if (/\/calendar/i.test(u)) return false;
      if (/top 10 best ai apps/i.test(t) || /top10\.com\/best/i.test(u)) return false;
      if (/best ai apps & websites/i.test(t)) return false;
      return true;
    });

    // ── 后处理: 域名过滤 + 去重 + 截断 ──
    let filtered = rawResults.filter(r => filterDomains(r.url, allowed, allowed ? undefined : blocked));
    if (!filtered.length && rawResults.length) filtered = rawResults;
    filtered = dedupResults(filtered).slice(0, n);

    if (!filtered.length) {
      return `(未找到与 "${query}" 相关的结果。请尝试:\n`
        + `1. 使用更通用的搜索词\n`
        + `2. 在 settings.json 中配置 web_search.provider 为 zhipu/tavily/brave/exa/firecrawl 并填入对应 API key\n`
        + `3. 检查网络连接是否正常)`;
    }

    // ── 内容增强: 并行抓取前 3 条结果的页面内容（httpRequest 支持智能代理）──
    const enrichTopN = Math.min(3, filtered.length);
    await Promise.allSettled(filtered.slice(0, enrichTopN).map(async (r) => {
      try {
        const html = await httpRequest(r.url, 'GET', undefined, 3000);
        let text = htmlToReadable(html);
        if (text.length > 100) {
          r.snippet = text.slice(0, 2000);
        }
      } catch { /* 抓取失败不影响搜索结果 */ }
    }));

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

// ── Jina Reader: 快速内容提取（优先使用，失败回退到原始 HTTP）──
async function jinaReader(url: string, timeout = 8000): Promise<string | null> {
  const jinaUrl = `https://r.jina.ai/${url}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const resp = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: { "User-Agent": PRODUCT_NAME, "Accept": "text/plain" },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text || text.length < 50) return null;
    return text.trim();
  } catch { return null; }
}

// ── 易超时域名过滤 ──
const SLOW_DOMAINS = ["news.google.com", "duckduckgo.com", "lite.duckduckgo.com", "html.duckduckgo.com", "google.com/search", "bing.com/search"];
function isSlowDomain(url: string): boolean {
  return SLOW_DOMAINS.some(d => url.includes(d));
}

// ── 网页抓取缓存 ──
const _fetchCache = new Map<string, [number, string]>();
const FETCH_CACHE_MAX = 20;
const FETCH_CACHE_TTL = 300000; // 5 分钟

// ── 抓取网页全文 ──
registry.register(
  "抓取网页全文并提取可读文本。仅在 web_search 摘要不够时使用，避免不必要抓取。\n"
    + "参数:\n"
    + "  url       目标网址 (必填，须以 http:// 或 https:// 开头)\n"
    + "  max_chars 最大返回字符数 (可选，默认 8000，最大 20000)\n"
    + "用法: web_fetch(url=\"https://docs.python.org/3/whatsnew/3.13.html\")\n"
    + "      web_fetch(url=\"https://long-article.com\", max_chars=8000)\n"
    + "⚠️ 避免抓取 news.google.com、duckduckgo.com 等易超时站点。",
  RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string", max_chars: "integer" },
  async function web_fetch(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    if (!/^https?:\/\//i.test(url)) return "(x) URL 须以 http:// 或 https:// 开头";
    const maxCharsArg = Number(args["max_chars"] || 0);
    const limit = Math.min(maxCharsArg > 0 ? maxCharsArg : 8000, 20000);

    // ── 易超时域名警告 ──
    if (isSlowDomain(url)) {
      return `(⚠️) ${url} 是已知的慢速域名，抓取可能超时。建议从搜索结果中选择其他来源。`;
    }

    // ── 检查缓存 ──
    const cacheKey = `${url}|${limit}`;
    const cached = _fetchCache.get(cacheKey);
    if (cached && Date.now() - cached[0] < FETCH_CACHE_TTL) {
      return cached[1] + "\n[缓存命中]";
    }

    // 回退函数：Firecrawl → Jina Reader（HTTP 失败或解析为空时使用）
    const tryFallback = async (): Promise<string | null> => {
      try {
        const fcResp = await fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["markdown"] }),
          signal: AbortSignal.timeout(8000),
        });
        if (fcResp.ok) {
          const fcData = await fcResp.json() as { data?: { markdown?: string; metadata?: { title?: string } } };
          const md = fcData.data?.markdown || "";
          const title = fcData.data?.metadata?.title || "";
          if (md.length > 100) {
            return `--- ${url} ---${title ? `\n标题: ${title}` : ""}\n\n${truncateMiddle(md, limit, 0.8)}`;
          }
        }
      } catch { /* fall through to Jina */ }
      const jinaText = await jinaReader(url, 8000);
      if (jinaText && jinaText.length > 100) {
        return `--- ${url} ---\n\n${truncateMiddle(jinaText, limit, 0.8)}`;
      }
      return null;
    };

    // ── 策略 1: 原始 HTTP + HTML 解析（默认，无需外部服务）──
    try {
      const html = await httpRequest(url, 'GET', undefined, 8000);
      const ct = html.startsWith("{") ? "application/json" : "text/html";

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

      // HTML 解析结果为空或太短 → 回退到 Firecrawl/Jina
      if (!text.trim() || text.trim().length < 100) {
        const fallback = await tryFallback();
        if (fallback) {
          if (_fetchCache.size >= FETCH_CACHE_MAX) _fetchCache.clear();
          _fetchCache.set(cacheKey, [Date.now(), fallback]);
          return fallback;
        }
        // Firecrawl/Jina 也失败 → 返回原始 HTML 纯文本（至少给 agent 一些内容）
        const rawText = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        if (rawText.length > 50) {
          const result = `${header}${truncateMiddle(rawText, limit, 0.8)}`;
          if (_fetchCache.size >= FETCH_CACHE_MAX) _fetchCache.clear();
          _fetchCache.set(cacheKey, [Date.now(), result]);
          return result;
        }
        return `--- ${url} ---\n(无有效文本)`;
      }

      const result = header + truncateMiddle(text, limit, 0.8);
      if (_fetchCache.size >= FETCH_CACHE_MAX) _fetchCache.clear();
      _fetchCache.set(cacheKey, [Date.now(), result]);
      return result;
    } catch (httpErr: unknown) {
      // ── 策略 2+3: Firecrawl → Jina（HTTP 失败时回退）──
      const fallback = await tryFallback();
      if (fallback) {
        if (_fetchCache.size >= FETCH_CACHE_MAX) _fetchCache.clear();
        _fetchCache.set(cacheKey, [Date.now(), fallback]);
        return fallback;
      }
      const msg = httpErr instanceof Error ? httpErr.message : String(httpErr);
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
      const headers: Record<string, string> = {};
      const headersRaw = String(args["headers"] || "");
      if (headersRaw) {
        try { Object.assign(headers, JSON.parse(headersRaw)); } catch { /* ignore malformed */ }
      }
      const resp = await fetch(url, { method, body: args["body"] ? String(args["body"]) : undefined, headers });
      return `HTTP ${resp.status}\n${(await resp.text()).slice(0, 2000)}`;
    } catch (e) { return `(x) ${e}`; }
  },
);
