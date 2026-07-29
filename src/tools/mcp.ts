/**
 * MCP 客户端 + 注册表 — 与 Python tools_mcp.py 完全对应
 * 15 个内置 MCP Server 注册表 + JSON-RPC 协议交互
 */
import { spawnSync, spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

export interface McpRegistryEntry {
  name: string;
  desc: string;
  category: string;
  install: string[];
  requires: string;
  url?: string;
}

export const MCP_REGISTRY: Record<string, McpRegistryEntry> = {
  playwright: { name: "Playwright MCP", desc: "浏览器自动化（Microsoft 官方）— 页面导航/截图/表单填写/数据提取", category: "browser", install: ["npx", "-y", "@playwright/mcp@latest"], requires: "node" },
  fetch: { name: "Fetch MCP", desc: "HTTP 抓取 + HTML→Markdown 转换，适合网页内容提取", category: "network", install: ["pip", "install", "mcp-server-fetch"], requires: "python" },
  filesystem: { name: "Filesystem MCP", desc: "安全文件系统操作 — 读写/列表/搜索（可限制目录范围）", category: "filesystem", install: ["npx", "-y", "@modelcontextprotocol/server-filesystem"], requires: "node" },
  sqlite: { name: "SQLite MCP", desc: "本地 SQLite 数据库查询与分析（官方 Python 实现，原 npm 包已下架）", category: "database", install: ["uvx", "mcp-server-sqlite", "--db-path", "agent.db"], requires: "python" },
  postgres: { name: "PostgreSQL MCP", desc: "PostgreSQL 只读查询 — Schema 检查 + SQL 执行", category: "database", install: ["npx", "-y", "@modelcontextprotocol/server-postgres"], requires: "node" },
  "chrome-devtools": { name: "Chrome DevTools MCP", desc: "Chrome DevTools 协议直连 — 性能分析/调试/截图/DOM 操作", category: "browser", install: ["npx", "-y", "chrome-devtools-mcp@latest"], requires: "node" },
  docker: { name: "Docker MCP", desc: "Docker 容器与镜像管理", category: "infra", install: ["npx", "-y", "@cpecf/docker-mcp"], requires: "node" },
  context7: { name: "Context7", desc: "实时库/框架文档查询 — 解决 LLM 知识截止问题（推荐 npx -y @upstash/context7-mcp stdio 模式）", category: "knowledge", install: ["npx", "-y", "@upstash/context7-mcp"], requires: "node", url: "https://mcp.context7.com/mcp" },
  github: { name: "GitHub MCP", desc: "GitHub PR/Issue/代码搜索/仓库管理", category: "devtools", install: [], requires: "github_token", url: "https://api.githubcopilot.com/mcp/" },
  slack: { name: "Slack MCP", desc: "Slack 频道消息发送/文件上传/工作流", category: "communication", install: ["npx", "-y", "@modelcontextprotocol/server-slack"], requires: "slack_token" },
  memory: { name: "Memory MCP", desc: "持久化知识图谱记忆系统", category: "knowledge", install: ["npx", "-y", "@modelcontextprotocol/server-memory"], requires: "node" },
  "brave-search": { name: "Brave Search MCP", desc: "Brave Search API 联网搜索（需 API Key）", category: "network", install: ["npx", "-y", "@modelcontextprotocol/server-brave-search"], requires: "brave_api_key" },
  puppeteer: { name: "Puppeteer MCP", desc: "Puppeteer 浏览器自动化 — 轻量级网页交互（推荐设置 PUPPETEER_EXECUTABLE_PATH 指向系统 Chrome 避免下载 Chromium）", category: "browser", install: ["npx", "-y", "@modelcontextprotocol/server-puppeteer"], requires: "node" },
  everart: { name: "EverArt MCP", desc: "AI 图像生成（通过 EverArt API）", category: "media", install: ["npx", "-y", "@modelcontextprotocol/server-everart"], requires: "everart_api_key" },
  "sequential-thinking": { name: "Sequential Thinking MCP", desc: "多步推理与思维链增强", category: "reasoning", install: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"], requires: "node" },
  "cua-driver": { name: "CUA Driver", desc: "后台桌面控制 MCP server（Rust v0.8.3 跨平台）— 截图/点击/键盘/拖拽/滚动/应用管理，不抢占光标", category: "computer", install: ["cua-driver", "mcp"], requires: "node" },
  officecli: { name: "OfficeCLI MCP", desc: "Office 文档操作 MCP — 创建/编辑 Word(.docx) Excel(.xlsx) PowerPoint(.pptx)，通过命名管道高性能通信，首次自动安装", category: "office", install: ["officecli", "mcp"], requires: "none" },
};

// ── Windows command resolution ──
function resolveCommand(cmd: string[]): string[] {
  if (process.platform === "win32") {
    // On Windows, npx/npm are .cmd files — spawn needs shell:true or full path
    const which = require("child_process").spawnSync("where", [cmd[0]], { encoding: "utf-8" });
    if (which.status === 0 && which.stdout.trim()) {
      cmd[0] = which.stdout.trim().split(/\r?\n/)[0];
    }
  }
  return cmd;
}

// ── MCP JSON-RPC exchange ──
export function mcpExchange(serverCmd: string[], requests: string[], timeout = 90000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const resolvedCmd = resolveCommand([...serverCmd]);
    const proc = spawn(resolvedCmd[0], resolvedCmd.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",  // Windows 需要 shell 模式来解析 .cmd 文件
    });
    const responses: any[] = [];
    const lineBuffer: string[] = [];
    let resolved = false;
    let currentRequestIdx = 0;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve(responses);
      }
    }, timeout);

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    proc.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(responses);
      }
    });

    // 逐行读取 stdout
    proc.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const ch of text) {
        if (ch === "\n") {
          const line = lineBuffer.join("").trim();
          lineBuffer.length = 0;
          if (!line) continue;
          try {
            const resp = JSON.parse(line);
            responses.push(resp);
            // 收到响应后发送下一个请求
            sendNextRequest();
          } catch { /* skip non-JSON */ }
        } else {
          lineBuffer.push(ch);
        }
      }
    });

    proc.stderr.on("data", () => { /* 吞掉 stderr 防止死锁 */ });

    function sendNextRequest() {
      currentRequestIdx++;
      while (currentRequestIdx < requests.length) {
        const req = requests[currentRequestIdx];
        proc.stdin.write(req + "\n");
        try {
          const parsed = JSON.parse(req);
          if ("id" in parsed) {
            // 有 id 的请求，等待响应
            return;
          }
          // 通知（无 id），继续发送下一个
          currentRequestIdx++;
        } catch {
          currentRequestIdx++;
        }
      }
      // 所有请求已发送，关闭 stdin
      try { proc.stdin.end(); } catch { /* already closed */ }
    }

    // 发送第一个请求
    if (requests.length > 0) {
      proc.stdin.write(requests[0] + "\n");
      try {
        const parsed = JSON.parse(requests[0]);
        if (!("id" in parsed)) {
          // 第一个是通知，继续发送
          sendNextRequest();
        }
      } catch { /* skip */ }
    } else {
      try { proc.stdin.end(); } catch { /* */ }
    }
  });
}

export function splitArgs(argsStr: string): string[] {
  if (!argsStr) return [];
  // Simple space-based split (matching Python shlex for common cases)
  return argsStr.split(/\s+/).filter(Boolean);
}

registry.register(
  "列出已配置的 MCP 服务器 + 注册表中可用的服务器。\n从 settings.json 读取 mcpServers 段 + MCP_REGISTRY 内置注册表。",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function mcp_list_servers(): string {
    let configured: Record<string, any> = {};
    try {
      const { loadSettings } = require("../config.js");
      configured = (loadSettings().mcpServers || {}) as Record<string, any>;
    } catch { /* ignore */ }
    const lines: string[] = [];
    if (Object.keys(configured).length > 0) {
      lines.push(`=== 已配置 (${Object.keys(configured).length} 个) ===\n`);
      for (const [name, cfg] of Object.entries(configured)) {
        const cmd = cfg.command || cfg.url || "?";
        const args = (cfg.args || []).join(" ");
        const desc = cfg.description || "";
        lines.push(`  [${name}] ${cmd} ${args}`);
        if (desc) lines.push(`         ${desc}`);
      }
    } else {
      lines.push("=== 已配置 (0 个) ===\n  (无)\n");
    }
    const available = Object.fromEntries(
      Object.entries(MCP_REGISTRY).filter(([k]) => !(k in configured))
    );
    if (Object.keys(available).length > 0) {
      lines.push(`\n=== 注册表可用 (${Object.keys(available).length} 个，未安装) ===\n`);
      for (const [key, info] of Object.entries(available)) {
        const req = info.requires;
        const icon = { none: "🟢", node: "🟡", python: "🟡", cua_driver: "🟡", blender: "🟡" }[req] || "🔑";
        lines.push(`  ${icon} ${key.padEnd(20)} — ${info.desc.slice(0, 55)}`);
      }
    }
    lines.push(`\n安装: mcp_install(server="<name>")  |  试用: mcp_quick(server="<name>")`);
    lines.push(`注册表: mcp_registry()`);
    return lines.join("\n");
  },
);

registry.register(
  "启动 MCP 服务器并列出其提供的所有工具。\n用法: mcp_list_tools(serverCommand=\"npx\", serverArgs=\"-y @playwright/mcp@latest\")",
  RiskLevel.SYSTEM, Capability.MCP,
  { workDir: "string", serverCommand: "string", serverArgs: "string" },
  async function mcp_list_tools(_wd: string, args: Record<string, unknown>): Promise<string> {
    const serverCommand = String(args["serverCommand"]);
    const serverArgs = String(args["serverArgs"] || "");
    const cmd = [serverCommand, ...splitArgs(serverArgs)];
    try {
      const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cortex-agent", version: "1.0" } } });
      const notified = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listReq = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const responses = await mcpExchange(cmd, [init, notified, listReq]);
      let tools: any[] = [];
      for (const msg of responses) {
        if (msg.result && msg.result.tools) tools = msg.result.tools;
      }
      if (!tools.length) return `(x) 服务器未返回工具列表 (收到 ${responses.length} 条响应)`;
      const out = [`来自 ${serverCommand} 的 ${tools.length} 个工具:\n`];
      for (const t of tools) {
        out.push(`  ● ${t.name || "?"}: ${(t.description || "").slice(0, 80)}`);
      }
      return out.join("\n");
    } catch (e) { return `(x) MCP 错误: ${e}`; }
  },
);

registry.register(
  "调用 MCP 服务器上的工具。\n用法: mcp_call_tool(serverCommand=\"npx\", serverArgs=\"-y @playwright/mcp@latest\", toolName=\"browser_navigate\", toolArgs='{\"url\":\"https://example.com\"}')",
  RiskLevel.SYSTEM, Capability.MCP,
  { workDir: "string", serverCommand: "string", serverArgs: "string", toolName: "string", toolArgs: "string" },
  async function mcp_call_tool(_wd: string, args: Record<string, unknown>): Promise<string> {
    const serverCommand = String(args["serverCommand"]);
    const serverArgs = String(args["serverArgs"] || "");
    const toolName = String(args["toolName"] || "");
    const toolArgs = String(args["toolArgs"] || "{}");
    const cmd = [serverCommand, ...splitArgs(serverArgs)];
    let argsDict: Record<string, unknown> = {};
    try { argsDict = JSON.parse(toolArgs); } catch { return `(x) toolArgs 不是有效的 JSON: ${toolArgs.slice(0, 100)}`; }
    try {
      const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cortex-agent", version: "1.0" } } });
      const notified = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      const callReq = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: toolName, arguments: argsDict } });
      const responses = await mcpExchange(cmd, [init, notified, callReq]);
      // 优先返回 id=2 的响应（工具调用结果），含 error 也要返回
      for (let i = responses.length - 1; i >= 0; i--) {
        const msg = responses[i];
        if (msg.id === 2) {
          if (msg.error) return `(x) MCP 工具错误: ${msg.error.message || JSON.stringify(msg.error)}`;
          if (msg.result) {
            const content = msg.result.content;
            if (Array.isArray(content)) {
              const texts = content.filter((c: any) => c.text).map((c: any) => c.text);
              if (texts.length) return texts.join("\n").slice(0, 3000);
            }
            return JSON.stringify(msg.result).slice(0, 3000);
          }
        }
      }
      // 回退：任意含 result 的响应
      for (let i = responses.length - 1; i >= 0; i--) {
        const msg = responses[i];
        if (msg.result) {
          const content = msg.result.content;
          if (Array.isArray(content)) {
            const texts = content.filter((c: any) => c.text).map((c: any) => c.text);
            if (texts.length) return texts.join("\n").slice(0, 3000);
          }
          return JSON.stringify(msg.result).slice(0, 3000);
        }
      }
      return `(x) 无有效响应 (收到 ${responses.length} 条)`;
    } catch (e) { return `(x) MCP 调用失败: ${e}`; }
  },
);

registry.register(
  "列出已知的 MCP Server 注册表，包含安装命令和分类。\n用法: mcp_registry(category=\"\")  — 留空列出全部，指定分类筛选",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", category: "string" },
  function mcp_registry(_wd: string, args: Record<string, unknown>): string {
    const cat = String(args["category"] || "");
    let entries = Object.entries(MCP_REGISTRY);
    if (cat) {
      entries = entries.filter(([, v]) => v.category === cat);
      if (!entries.length) {
        const cats = [...new Set(Object.values(MCP_REGISTRY).map(v => v.category))].sort();
        return `(x) 未知分类: ${cat}\n可用分类: ${cats.join(", ")}`;
      }
    }
    const lines = [`MCP Server 注册表 (${entries.length} 个):\n`];
    const byCat: Record<string, [string, McpRegistryEntry][]> = {};
    for (const [key, info] of entries) {
      const c = info.category || "other";
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push([key, info]);
    }
    for (const c of Object.keys(byCat).sort()) {
      lines.push(`\n${"─".repeat(40)}`);
      lines.push(`  [${c}]`);
      for (const [key, info] of byCat[c]) {
        const req = info.requires;
        const icon = { none: "🟢", node: "🟡", python: "🟡", cua_driver: "🟡", blender: "🟡" }[req] || "🔑";
        lines.push(`  ${icon} ${key.padEnd(20)} — ${info.desc.slice(0, 60)}`);
        if (!["none", "node", "python"].includes(req)) {
          lines.push(`     ${" ".repeat(22)} 需要: ${req}`);
        }
      }
    }
    lines.push(`\n${"─".repeat(40)}`);
    lines.push(`\n安装: mcp_install(server="playwright")`);
    lines.push(`快速试用: mcp_quick(server="fetch")`);
    return lines.join("\n");
  },
);
