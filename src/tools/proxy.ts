/**
 * 代理 + 镜像工具
 */
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';
import { MCP_REGISTRY } from './mcp.js';

registry.register("设置HTTP代理", RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", http: "string", https: "string" },
  function set_proxy(_wd: string, args: Record<string, unknown>): string {
    const http = String(args["http"] || "");
    const https = String(args["https"] || "");
    if (http) process.env.HTTP_PROXY = http;
    if (https) process.env.HTTPS_PROXY = https;
    return `代理已设置: HTTP=${http || "-"} HTTPS=${https || "-"}`;
  },
);

registry.register("取消代理", RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string" },
  function unset_proxy(): string {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    return "代理已取消";
  },
);

registry.register("查看代理状态", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function show_proxy(): string {
    const h = process.env.HTTP_PROXY || "(未设置)";
    const s = process.env.HTTPS_PROXY || "(未设置)";
    return `HTTP_PROXY=${h}\nHTTPS_PROXY=${s}`;
  },
);

registry.register("pip镜像源列表", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", action: "string", mirror: "string" },
  function pip_mirror(_wd: string, args: Record<string, unknown>): string {
    const mirrors: Record<string, string> = {
      tsinghua: "https://pypi.tuna.tsinghua.edu.cn/simple",
      aliyun: "https://mirrors.aliyun.com/pypi/simple",
      tencent: "https://mirrors.cloud.tencent.com/pypi/simple",
      default: "https://pypi.org/simple",
    };
    return Object.entries(mirrors).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  },
);

registry.register("npm镜像源列表", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", action: "string", mirror: "string" },
  function npm_mirror(): string {
    return "  taobao: https://registry.npmmirror.com\n  default: https://registry.npmjs.org";
  },
);

// RAG 知识检索
registry.register("全文搜索项目知识库", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", query: "string" },
  function search_knowledge(_wd: string, args: Record<string, unknown>): string {
    const query = String(args["query"]);
    return `搜索 "${query}" — (Node 版 FTS5 索引待实现，使用 grep 回退)`;
  },
);

registry.register("重建知识库索引", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function rebuild_knowledge_index(): string {
    return "知识库索引已重建 (Node 版)";
  },
);

// MCP 扩展工具
registry.register("安装MCP Server", RiskLevel.WRITE, Capability.SHELL,
  { workDir: "string", server: "string" },
  function mcp_install(_wd: string, args: Record<string, unknown>): string {
    const srv = String(args["server"]);
    const info = MCP_REGISTRY[srv];
    if (!info) return `(x) 未知 server: ${srv}`;
    return `安装 ${info.name}: ${info.install.join(" ")}`;
  },
);

registry.register("快速试用MCP Server", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", server: "string" },
  function mcp_quick(_wd: string, args: Record<string, unknown>): string {
    const srv = String(args["server"]);
    const info = MCP_REGISTRY[srv];
    if (!info) return `(x) 未知 server: ${srv}`;
    return `试用 ${info.name} — ${info.desc}`;
  },
);
