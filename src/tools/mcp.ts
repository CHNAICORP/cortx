/**
 * MCP 客户端 + 注册表
 */
import { spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

export const MCP_REGISTRY: Record<string, { name: string; desc: string; category: string; install: string[]; requires: string }> = {
  playwright: { name: "Playwright MCP", desc: "浏览器自动化（Microsoft 官方）", category: "browser", install: ["npx", "-y", "@playwright/mcp@latest"], requires: "node" },
  fetch: { name: "Fetch MCP", desc: "HTTP 抓取 + HTML→Markdown", category: "network", install: ["pip", "install", "mcp-server-fetch"], requires: "python" },
  sqlite: { name: "SQLite MCP", desc: "本地 SQLite 数据库查询", category: "database", install: ["npx", "-y", "@modelcontextprotocol/server-sqlite"], requires: "node" },
  context7: { name: "Context7", desc: "实时库/框架文档查询（URL 直连）", category: "knowledge", install: [], requires: "none" },
};

registry.register("列出已配置的 MCP 服务器", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function mcp_list_servers(): string {
    const lines = ["=== MCP 注册表 ===\n"];
    for (const [key, info] of Object.entries(MCP_REGISTRY)) {
      lines.push(`  ${key}: ${info.desc} (${info.requires})`);
    }
    return lines.join("\n");
  },
);

registry.register("列出 MCP Server 工具", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", serverCommand: "string", serverArgs: "string" },
  function mcp_list_tools(_wd: string, args: Record<string, unknown>): string {
    const cmd = String(args["serverCommand"]);
    const sargs = String(args["serverArgs"] || "");
    try {
      const result = spawnSync(cmd, sargs ? sargs.split(" ") : [], { timeout: 30000, encoding: "utf-8" });
      return result.stdout?.slice(0, 2000) || "(无输出)";
    } catch (e) { return `(x) MCP 错误: ${e}`; }
  },
);

registry.register("调用 MCP Server 工具", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", serverCommand: "string", serverArgs: "string", toolName: "string", toolArgs: "string" },
  function mcp_call_tool(_wd: string, args: Record<string, unknown>): string {
    const cmd = String(args["serverCommand"]);
    const sargs = String(args["serverArgs"] || "");
    try {
      const result = spawnSync(cmd, sargs ? sargs.split(" ") : [], { timeout: 30000, encoding: "utf-8" });
      return result.stdout?.slice(0, 3000) || "(无输出)";
    } catch (e) { return `(x) MCP 调用失败: ${e}`; }
  },
);

registry.register("MCP 注册表浏览", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", category: "string" },
  function mcp_registry(_wd: string, args: Record<string, unknown>): string {
    const cat = String(args["category"] || "");
    const filtered = cat ? Object.entries(MCP_REGISTRY).filter(([, v]) => v.category === cat)
      : Object.entries(MCP_REGISTRY);
    return filtered.map(([k, v]) => `  ${k}: ${v.desc}`).join("\n");
  },
);
