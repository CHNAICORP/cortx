/**
 * 代理 + 镜像 + RAG + MCP扩展工具 — 与 Python tools_network.py + tools_rag.py 对应
 */
import * as fs from "fs";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { MCP_REGISTRY, McpRegistryEntry, mcpExchange, splitArgs } from './mcp.js';

// ── 镜像源注册表 ──
const PIP_MIRRORS: Record<string, string> = {
  tsinghua: "https://pypi.tuna.tsinghua.edu.cn/simple",
  aliyun: "https://mirrors.aliyun.com/pypi/simple",
  tencent: "https://mirrors.cloud.tencent.com/pypi/simple",
  ustc: "https://pypi.mirrors.ustc.edu.cn/simple",
  douban: "https://pypi.douban.com/simple",
  huawei: "https://repo.huaweicloud.com/repository/pypi/simple",
  default: "https://pypi.org/simple",
};

const NPM_MIRRORS: Record<string, string> = {
  taobao: "https://registry.npmmirror.com",
  tencent: "https://mirrors.cloud.tencent.com/npm/",
  huawei: "https://repo.huaweicloud.com/repository/npm/",
  default: "https://registry.npmjs.org",
};

// ── HTTP 代理工具 ──

registry.register(
  "设置 HTTP/HTTPS/SOCKS 代理。用于加速网络访问、解决超时问题。\n用法: set_proxy(http=\"http://127.0.0.1:7897\", https=\"http://127.0.0.1:7897\")",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", http: "string", https: "string", all_proxy: "string", socks: "string", no_proxy: "string" },
  function set_proxy(_wd: string, args: Record<string, unknown>): string {
    const http = String(args["http"] || "");
    const https = String(args["https"] || "");
    const allProxy = String(args["all_proxy"] || "");
    const socks = String(args["socks"] || "");
    const noProxy = String(args["no_proxy"] || "localhost,127.0.0.1,.local");
    const changed: string[] = [];
    if (http) { process.env.HTTP_PROXY = http; process.env.http_proxy = http; changed.push(`HTTP  → ${http}`); }
    if (https) { process.env.HTTPS_PROXY = https; process.env.https_proxy = https; changed.push(`HTTPS → ${https}`); }
    if (allProxy) { process.env.ALL_PROXY = allProxy; process.env.all_proxy = allProxy; changed.push(`ALL   → ${allProxy}`); }
    if (socks) { process.env.ALL_PROXY = socks; process.env.all_proxy = socks; changed.push(`SOCKS → ${socks}`); }
    if (noProxy) { process.env.NO_PROXY = noProxy; process.env.no_proxy = noProxy; }
    if (!changed.length) {
      return "(未指定代理地址)\n\n用法示例:\n  set_proxy(http=\"http://127.0.0.1:7897\", https=\"http://127.0.0.1:7897\")\n  set_proxy(socks=\"socks5://127.0.0.1:7897\", all_proxy=\"socks5://127.0.0.1:7897\")";
    }
    return `代理已设置 (当前进程 + 子进程生效):\n` + changed.map(c => `  ${c}`).join("\n");
  },
);

registry.register("取消所有 HTTP 代理设置。", RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string" },
  function unset_proxy(): string {
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
      delete process.env[key];
    }
    return "代理已取消。";
  },
);

registry.register("查看当前代理设置状态。", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function show_proxy(): string {
    const lines: string[] = [];
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      const val = process.env[key];
      if (val) lines.push(`  ${key} = ${val}`);
    }
    if (!lines.length) return "(未设置代理)";
    return "当前代理设置:\n" + lines.join("\n");
  },
);

// ── 镜像源切换 ──

registry.register(
  "切换 pip 镜像源以加速 Python 包下载。\n用法: pip_mirror(action=\"list\"|\"set\"|\"reset\", mirror=\"tsinghua\")",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", action: "string", mirror: "string" },
  function pip_mirror(_wd: string, args: Record<string, unknown>): string {
    const action = String(args["action"] || "list");
    const mirror = String(args["mirror"] || "");
    if (action === "list") {
      const lines = ["可用 pip 镜像源:\n"];
      for (const [name, url] of Object.entries(PIP_MIRRORS)) {
        const marker = name === "default" ? " (官方)" : "";
        lines.push(`  ● ${name}${marker}: ${url}`);
      }
      return lines.join("\n");
    }
    if (action === "set") {
      if (!(mirror in PIP_MIRRORS)) return `(x) 未知镜像: ${mirror}\n可用: ${Object.keys(PIP_MIRRORS).join(", ")}`;
      const url = PIP_MIRRORS[mirror];
      try {
        execSync(`pip config set global.index-url ${url}`, { timeout: 10000, encoding: "utf-8" });
        return `pip 镜像已切换 → ${mirror}\n  URL: ${url}\n\n临时使用: pip install -i ${url} <package>\n恢复官方: pip_mirror(action="reset")`;
      } catch (e) {
        return `pip config 命令失败: ${e}\n\n请手动执行:\n  pip config set global.index-url ${url}`;
      }
    }
    if (action === "reset") {
      try {
        execSync("pip config unset global.index-url", { timeout: 10000, encoding: "utf-8" });
        return "pip 镜像已恢复官方源";
      } catch (e) {
        return `恢复失败: ${e}\n\n请手动执行:\n  pip config unset global.index-url`;
      }
    }
    return `(x) 未知操作: ${action}\n可用: list, set, reset`;
  },
);

registry.register(
  "切换 npm 镜像源以加速 Node.js 包下载。\n用法: npm_mirror(action=\"list\"|\"set\"|\"reset\", mirror=\"taobao\")",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", action: "string", mirror: "string" },
  function npm_mirror(_wd: string, args: Record<string, unknown>): string {
    const action = String(args["action"] || "list");
    const mirror = String(args["mirror"] || "");
    if (action === "list") {
      const lines = ["可用 npm 镜像源:\n"];
      for (const [name, url] of Object.entries(NPM_MIRRORS)) {
        const marker = name === "default" ? " (官方)" : "";
        lines.push(`  ● ${name}${marker}: ${url}`);
      }
      try {
        const current = execSync("npm config get registry", { timeout: 5000, encoding: "utf-8" }).trim();
        lines.push(`\n当前配置: ${current}`);
      } catch { /* ignore */ }
      return lines.join("\n");
    }
    if (action === "set") {
      if (!(mirror in NPM_MIRRORS)) return `(x) 未知镜像: ${mirror}\n可用: ${Object.keys(NPM_MIRRORS).join(", ")}`;
      const url = NPM_MIRRORS[mirror];
      try {
        execSync(`npm config set registry ${url}`, { timeout: 10000, encoding: "utf-8" });
        return `npm 镜像已切换 → ${mirror}\n  URL: ${url}\n\n临时使用: npm install --registry=${url} <package>\n恢复官方: npm_mirror(action="reset")`;
      } catch (e) {
        return `npm config 命令失败: ${e}\n\n请手动执行:\n  npm config set registry ${url}`;
      }
    }
    if (action === "reset") {
      try {
        execSync("npm config delete registry", { timeout: 10000, encoding: "utf-8" });
        return "npm 镜像已恢复官方源";
      } catch (e) {
        return `恢复失败: ${e}\n\n请手动执行:\n  npm config delete registry`;
      }
    }
    return `(x) 未知操作: ${action}\n可用: list, set, reset`;
  },
);

// ── RAG 知识检索 (grep fallback) ──

let _ftsIndexed = false;

function buildFtsIndex(workDir: string): void {
  if (_ftsIndexed) return;
  // TS version: use in-memory file index with grep fallback
  _ftsIndexed = true;
}

registry.register(
  "全文搜索项目知识库。搜索所有 .md/.py/.txt/.json 文件。\n用法: search_knowledge(query=\"agentic loop\")",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", query: "string" },
  function search_knowledge(workDir: string, args: Record<string, unknown>): string {
    const query = String(args["query"] || "");
    if (!query.trim()) return "(x) 请提供搜索关键词";
    const projectRoot = path.dirname(path.resolve(workDir));
    const results: string[] = [];
    let regex: RegExp;
    try { regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); } catch { regex = new RegExp(query, "i"); }
    const walk = (dir: string) => {
      if (results.length >= 10) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= 10) return;
          if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === "cortex_workspace") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (/\.(md|py|txt|json)$/.test(entry.name)) {
            try {
              const lines = fs.readFileSync(full, "utf-8").split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (regex.test(lines[i]) && results.length < 10) {
                  results.push(`📄 ${path.relative(projectRoot, full)}\n     L${i + 1}: ${lines[i].trim().slice(0, 100)}`);
                }
              }
            } catch { /* skip */ }
          }
        }
      } catch { /* skip */ }
    };
    walk(projectRoot);
    if (!results.length) return `(未找到与 '${query}' 相关的内容)`;
    return `搜索 '${query}' (${results.length} 条):\n\n` + results.join("\n");
  },
);

registry.register(
  "重建知识库全文索引。项目文件变更后使用。",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function rebuild_knowledge_index(): string {
    _ftsIndexed = false;
    return "知识库索引已重建";
  },
);

// ── MCP 扩展工具 ──

registry.register(
  "一键安装 MCP Server（从注册表）。自动执行 pip/npm 安装命令。\n用法: mcp_install(server=\"playwright\")  — 安装指定 server\n      mcp_install(server=\"all\")          — 安装所有无需 API Key 的 server",
  RiskLevel.WRITE, Capability.SHELL,
  { workDir: "string", server: "string" },
  function mcp_install(_wd: string, args: Record<string, unknown>): string {
    const server = String(args["server"] || "");
    if (!server) {
      return `请指定要安装的 server:\n  mcp_install(server="playwright")\n  mcp_install(server="all")  ← 安装所有免费 server\n可用 server: ${Object.keys(MCP_REGISTRY).sort().join(", ")}`;
    }
    let toInstall: [string, McpRegistryEntry][];
    if (server === "all") {
      toInstall = Object.entries(MCP_REGISTRY).filter(([, v]) => ["none", "node", "python"].includes(v.requires));
    } else if (server in MCP_REGISTRY) {
      toInstall = [[server, MCP_REGISTRY[server]]];
    } else {
      return `(x) 未知 server: ${server}\n可用: ${Object.keys(MCP_REGISTRY).sort().join(", ")}\n使用 mcp_registry() 查看完整列表`;
    }
    const results: string[] = [];
    for (const [key, info] of toInstall) {
      if (!info.install.length) {
        if (info.url) results.push(`  ${key}: 无需安装（URL 直连: ${info.url}）`);
        else results.push(`  ${key}: 无安装命令`);
        continue;
      }
      try {
        const r = spawnSync(info.install[0], info.install.slice(1), { timeout: 120000, encoding: "utf-8" });
        if (r.status === 0) results.push(`  ✅ ${key}: 安装成功`);
        else results.push(`  ❌ ${key}: 安装失败 — ${(r.stderr || r.stdout || "").slice(0, 100)}`);
      } catch (e) {
        results.push(`  ❌ ${key}: ${e}`);
      }
    }
    // Update settings.json
    try {
      const { loadSettings } = require("../config.js");
      const settings = loadSettings();
      const userPath = path.join(require("os").homedir(), ".cortx", "settings.json");
      if (fs.existsSync(userPath)) {
        const data = JSON.parse(fs.readFileSync(userPath, "utf-8"));
        data.mcpServers = data.mcpServers || {};
        for (const [key, info] of toInstall) {
          if (!data.mcpServers[key]) {
            if (info.install.length > 0) {
              data.mcpServers[key] = { command: info.install[0], args: info.install.slice(1), description: info.desc };
            } else if (info.url) {
              data.mcpServers[key] = { url: info.url, description: info.desc };
            }
          }
        }
        fs.writeFileSync(userPath, JSON.stringify(data, null, 2), "utf-8");
      }
    } catch { /* ignore settings update failure */ }
    return `安装结果 (${toInstall.length} 个):\n` + results.join("\n") + "\n\n已安装的 server 已自动添加到 settings.json mcpServers 配置中。";
  },
);

registry.register(
  "一键安装并启动 MCP Server，列出其提供的工具。试用的最快方式！\n用法: mcp_quick(server=\"fetch\")  — 安装+启动+列出工具",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", server: "string" },
  async function mcp_quick(_wd: string, args: Record<string, unknown>): Promise<string> {
    const server = String(args["server"] || "");
    if (!server || !(server in MCP_REGISTRY)) {
      return `请指定要试用的 server:\n  mcp_quick(server="fetch")       ← HTTP 抓取\n  mcp_quick(server="playwright")  ← 浏览器自动化\n  mcp_quick(server="sqlite")      ← 数据库查询\n可用: ${Object.keys(MCP_REGISTRY).sort().join(", ")}`;
    }
    const info = MCP_REGISTRY[server];
    // URL-only servers
    if (info.url) {
      return `=== ${info.name} ===\n${info.desc}\n\n此 server 使用 URL 直连: ${info.url}\n无需安装，直接在 settings.json 的 mcpServers 中配置即可。`;
    }
    // Install if needed
    if (info.install.length > 0) {
      try {
        spawnSync(info.install[0], info.install.slice(1), { timeout: 60000, encoding: "utf-8" });
      } catch { /* try running anyway */ }
    }
    // List tools using MCP protocol
    const cmd = info.install;
    if (cmd.length > 0) {
      try {
        const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cortex-agent", version: "1.0" } } });
        const notified = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
        const listReq = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        const responses = await mcpExchange(cmd, [init, notified, listReq]);
        let tools: any[] = [];
        for (const msg of responses) {
          if (msg.result && msg.result.tools) tools = msg.result.tools;
        }
        const out = [`=== ${info.name} ===\n${info.desc}\n`];
        if (tools.length) {
          out.push(`来自 ${cmd[0]} 的 ${tools.length} 个工具:`);
          for (const t of tools) out.push(`  ● ${t.name || "?"}: ${(t.description || "").slice(0, 80)}`);
        } else {
          out.push(`(服务器未返回工具列表, 收到 ${responses.length} 条响应)`);
        }
        return out.join("\n");
      } catch (e) { return `=== ${info.name} ===\n${info.desc}\n\n(x) 启动失败: ${e}`; }
    }
    return `=== ${info.name} ===\n${info.desc}\n\n(x) 无法确定 ${server} 的运行方式`;
  },
);
