/**
 * 网络工具 — web_search + web_fetch
 */
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

registry.register(
  "联网搜索网页",
  RiskLevel.SAFE, Capability.NET_SEARCH,
  { workDir: "string", query: "string" },
  async function web_search(workDir: string, args: Record<string, unknown>): Promise<string> {
    const query = String(args["query"]);
    try {
      const url = `https://lite.duckduckgo.com/lite/`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
        },
        body: new URLSearchParams({ q: query }).toString(),
      });
      const html = await resp.text();
      const results: string[] = [];
      const linkRe = /<a[^>]*rel=["']nofollow["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
      let m;
      let count = 0;
      while ((m = linkRe.exec(html)) !== null && count < 5) {
        const u = m[1];
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        if (!title || u.includes("duckduckgo.com")) continue;
        results.push(`[${count + 1}] ${title}\n    URL: ${u}`);
        count++;
      }
      if (!results.length) return "(未找到结果)";
      return `搜索 "${query}" (${results.length} 条):\n\n${results.join("\n\n")}`;
    } catch (e) {
      return `(x) 搜索失败: ${e}`;
    }
  },
);

registry.register(
  "抓取网页全文并提取可读文本",
  RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string", url: "string" },
  async function web_fetch(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    if (!/^https?:\/\//i.test(url)) return "(x) URL 须以 http:// 或 https:// 开头";
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)" },
        signal: AbortSignal.timeout(8000),
      });
      const html = await resp.text();
      // Simple HTML → text
      let text = html
        .replace(/<script[^>]*>.*?<\/script>/gsi, "")
        .replace(/<style[^>]*>.*?<\/style>/gsi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?(div|p|h[1-6]|li|tr|article|section)[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length > 8000) text = text.slice(0, 8000) + `\n\n[...已截断]`;
      return `--- ${url} ---\n${text || "(无有效文本)"}`;
    } catch (e) {
      return `(x) 抓取失败: ${e}`;
    }
  },
);
