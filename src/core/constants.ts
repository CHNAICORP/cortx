/**
 * Cortex Agent — 共享常量与工具函数
 *
 * 消除跨文件硬编码：ANSI 色板、User-Agent、路径、MCP 版本、截断/glob helper。
 * 与 Python cortex_agent/constants.py 对应。
 */
import * as path from "path";
import * as fs from "fs";
import { homedir } from "os";

// ── .cortx 目录 ──
export const CORTX_DIR = ".cortx";
export const cortxHomeDir = (): string => path.join(homedir(), CORTX_DIR);
export const cortxSettingsPath = (): string => path.join(cortxHomeDir(), "settings.json");
export const cortxWorkspaceDir = (): string => path.join(homedir(), CORTX_DIR, "workspace");
export const cortxSkillsDir = (projectDir?: string): string =>
  path.join(projectDir || process.cwd(), CORTX_DIR, "skills");

// ── User-Agent ──
export const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
export const USER_AGENT_SHORT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
export const PRODUCT_NAME = "cortex-agent";

// ── MCP 客户端版本（统一，消除 "1.0" vs "2.7.0" 不一致）──
export const MCP_CLIENT_VERSION = "2.9.12";
export const MCP_CLIENT_INFO = { name: PRODUCT_NAME, version: MCP_CLIENT_VERSION };

// ── ANSI 终端色板 ──
export const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  // 前景色
  BLACK: "\x1b[30m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  BLUE: "\x1b[34m",
  MAGENTA: "\x1b[35m",
  CYAN: "\x1b[36m",
  WHITE: "\x1b[37m",
  GRAY: "\x1b[90m",
  // 256 色（与 terminal.ts 对齐）
  GREEN_BRIGHT: "\x1b[38;5;82m",
  YELLOW_BRIGHT: "\x1b[38;5;220m",
  RED_BRIGHT: "\x1b[38;5;196m",
  DIM_245: "\x1b[38;5;245m",
  GRAY_240: "\x1b[38;5;240m",
} as const;

// ── 截断 helper（统一 head/tail 比例，消除 3 种不同比例）──
/**
 * 保留首尾、省略中间的截断。
 * @param text 原文
 * @param maxLen 最大字符数
 * @param headRatio 头部占比（默认 0.7）
 */
export function truncateMiddle(text: string, maxLen: number, headRatio = 0.7): string {
  if (text.length <= maxLen) return text;
  const head = Math.floor(maxLen * headRatio);
  const tail = Math.floor(maxLen * (1 - headRatio));
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[...已截断，省略 ${omitted} 字符...]\n\n${text.slice(-tail)}`;
}

// ── glob → regex 转义（消除 3 处重复）──
/**
 * 将 glob 通配符转为正则表达式。
 * * → .*，? → .，其他正则元字符转义。
 */
export function globToRegex(pattern: string, anchored = true): RegExp {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  if (anchored) re = "^" + re + "$";
  return new RegExp(re);
}

// ── 递归目录遍历（消除 3 处重复）──
/**
 * 递归遍历目录，跳过 .开头 / node_modules / __pycache__ / dist。
 * @param dir 起始目录
 * @param cb 每个文件的回调 (fullPath, entry)
 * @param maxResults 最大结果数（达到后停止）
 */
export function walkDir(
  dir: string,
  cb: (fullPath: string, entry: fs.Dirent) => void,
  maxResults = Infinity,
): number {
  let count = 0;
  const skip = new Set([".", "node_modules", "__pycache__", "dist", ".git", "cortex_workspace"]);
  const walk = (d: string) => {
    if (count >= maxResults) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= maxResults) return;
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        cb(full, entry);
        count++;
      }
    }
  };
  walk(dir);
  return count;
}

// ── 海外域名列表（直连可能超时，需要走代理）──
export const OVERSEAS_DOMAINS = [
  "github.com", "raw.githubusercontent.com", "huggingface.co",
  "stackoverflow.com", "pypi.org", "npmjs.com", "docs.python.org",
  "docs.djangoproject.com", "fastapi.tiangolo.com", "openai.com",
  "anthropic.com", "google.com", "techcrunch.com", "medium.com",
  "dev.to", "reddit.com", "arxiv.org", "readthedocs.io",
  "developer.mozilla.org", "w3.org", "runwayml.com", "pika.art",
  "lumalabs.ai", "expressjs.com", "react.dev", "vuejs.org",
  "nodejs.org", "go.dev", "rust-lang.org",
];

/** 判断 URL 是否需要走代理（海外域名直连可能超时） */
export function needsProxy(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OVERSEAS_DOMAINS.some(d => host === d || host.endsWith("." + d));
  } catch { return false; }
}

/** 获取代理地址（从环境变量读取） */
export function getProxyUrl(): string | null {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    || process.env.https_proxy || process.env.http_proxy || null;
}
