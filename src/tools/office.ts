/**
 * Office 文档工具 — 基于 OfficeCLI SDK (Node.js)
 * ═══════════════════════════════════════════════════════════════
 *
 * 通过 OfficeCLI 二进制 + 命名管道通信，提供高性能 Office 文档操作：
 *   Word (.docx) / Excel (.xlsx) / PowerPoint (.pptx)
 *
 * 工具列表:
 *   office_create    — 创建空白 Office 文档
 *   office_send      — 发送单条命令（通过命名管道，高性能）
 *   office_batch     — 批量执行命令（一次管道往返）
 *   office_view      — 查看文档内容（大纲/统计/文本/HTML）
 *   office_cli       — 直接执行 officecli CLI 命令（万能后门）
 *   office_install   — 安装/检查 officecli 二进制
 *
 * 首次使用时自动检测并安装 officecli 二进制（零配置）。
 */

import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

// @ts-ignore — CommonJS module without type declarations
const oc = require('./officecli-sdk.js');

// ── 文档会话缓存 ──
const _docSessions = new Map<string, any>();

// ── OfficeCLI GitHub Releases API ──
const GITHUB_RELEASES_API = 'https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest';

function resolvePath(workDir: string, filename: string): string {
  if (path.isAbsolute(filename)) return filename;
  return path.join(workDir, filename);
}

async function getOrOpenDoc(workDir: string, filename: string): Promise<any> {
  const full = resolvePath(workDir, filename);
  if (!_docSessions.has(full)) {
    _docSessions.set(full, await oc.open(full));
  }
  return _docSessions.get(full);
}

function formatResult(result: any): string {
  let text: string;
  if (typeof result === 'string') {
    text = result;
  } else {
    text = JSON.stringify(result, null, 2);
  }
  if (text.length > 8000) {
    text = text.slice(0, 8000) + '\n... (已截断)';
  }
  return text;
}

// ── 版本工具函数 ──

/** 获取当前已安装的 officecli 版本号 */
function getCurrentVersion(): { version: string; path: string } | null {
  const binary = oc.pipePaths ? resolveBinaryPath() : 'officecli';
  const r = spawnSync(binary, ['--version'], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  if (r.status === 0) {
    const version = (r.stdout || '').trim();
    return { version, path: binary };
  }
  return null;
}

/** 解析 SDK 的二进制路径（复用 SDK 内部 resolveBinary 逻辑） */
function resolveBinaryPath(): string {
  // SDK 内部 resolveBinary 优先检查 @officecli/officecli 包，然后 PATH，然后安装目录
  // 我们直接用 spawnSync 尝试 officecli --version，如果失败则尝试安装目录
  const candidates: string[] = [];
  // 1. 尝试 @officecli/officecli bundled binary
  try {
    const cli = require('@officecli/officecli');
    const p = cli.binaryPath();
    if (fs.existsSync(p)) candidates.push(p);
  } catch { /* dependency absent */ }
  // 2. PATH 上的 officecli
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['officecli'], { encoding: 'utf-8' });
  if (which.status === 0) {
    const found = which.stdout.trim().split(/\r?\n/)[0];
    if (found) candidates.push(found);
  }
  // 3. 安装目录
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA;
    if (base) candidates.push(path.join(base, 'OfficeCLI', 'officecli.exe'));
  } else {
    candidates.push(path.join(process.env.HOME || '~', '.local', 'bin', 'officecli'));
  }
  // 返回第一个存在的
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* */ }
  }
  return 'officecli';
}

/** 从 GitHub Releases API 获取最新版本号 */
function getLatestVersion(): { version: string; url: string } | null {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'powershell' : 'curl',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', `(irm '${GITHUB_RELEASES_API}' -Headers @{'User-Agent'='cortex-agent'}).tag_name`]
        : ['-fsSL', '-H', 'User-Agent: cortex-agent', GITHUB_RELEASES_API],
      { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 }
    );
    const output = (r.stdout || '').trim();
    if (process.platform !== 'win32') {
      // curl 返回 JSON，解析 tag_name
      try {
        const data = JSON.parse(output);
        const tag = (data.tag_name || '').replace(/^v/, '');
        if (tag) return { version: tag, url: data.html_url || '' };
      } catch { /* */ }
    } else {
      // PowerShell 直接返回 tag_name
      const tag = output.replace(/^v/, '').replace(/["']/g, '').trim();
      if (tag) return { version: tag, url: '' };
    }
  } catch { /* network error */ }
  return null;
}

/** 比较两个语义化版本号: 返回 1 表示 latest > current, 0 表示相等, -1 表示 latest < current */
function compareVersions(current: string, latest: string): number {
  const parseVer = (v: string) => v.replace(/^v/, '').split('.').map(n => parseInt(n.replace(/\D/g, '')) || 0);
  const a = parseVer(current);
  const b = parseVer(latest);
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    const va = a[i] || 0;
    const vb = b[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/** 关闭所有活跃的文档会话（更新前必须执行，避免文件锁冲突） */
async function closeAllSessions(): Promise<string[]> {
  const closed: string[] = [];
  for (const [fp, doc] of _docSessions) {
    try {
      await doc.close();
      closed.push(fp);
    } catch { /* best effort */ }
  }
  _docSessions.clear();
  return closed;
}

// ═══════════════════════════════════════════════════════════════
// 工具注册
// ═══════════════════════════════════════════════════════════════

registry.register(
  `创建空白 Office 文档（Word .docx / Excel .xlsx / PowerPoint .pptx）。首次使用时自动检测并安装 officecli 二进制（零配置）。

═══ Office 设计指南（必须遵守）═══

创建文档前，先选择设计方向，然后在 office_send/office_batch 中设置对应属性。

【PowerPoint .pptx 设计标准】
- 尺寸: 宽屏 33.87×19.05cm, 边距≥1.27cm, 块间距≥0.76cm
- 字号: 标题≥36pt bold, 副标题≥20pt, 正文≥18pt, 注释≥10pt
- 字体: 标题用 Georgia/Arial Black, 正文用 Calibri/Arial (两种以内)
- 配色(选一): Midnight Executive(1E2761/CADCFC/FFFFFF/333333/8899BB) |
  Coral Energy(F96167/F9E795/2F3C7E/333333/8B7E6A) |
  Charcoal Minimal(36454F/F2F2F2/212121/333333/7A8A94) |
  Ocean Gradient(065A82/1C7293/21295C/2B3A4E/6B8FAA)
  格式: Primary(60-70%)/Secondary/Accent/Text/Muted
- 每页必须有非文字视觉元素(shape/chart/icon), 不能只有文字
- 标题用 shape(非placeholder), layout=blank, 显式设置 x/y/width/height
- 封面: 深色背景+居中44pt标题+18pt副标题
- 数据页: 左2/3图表+右1/3评论卡片(roundRect背景)
- KPI页: 60pt大数字+≤5词副标签, 用shape不用chart
- 每页加 speaker notes: --type notes --prop text=...
- 禁止: 标题下装饰线, 圆角卡片左侧色条, emoji做图标

【Excel .xlsx 设计标准】
- 字体: 全工作簿统一 Arial 或 Calibri
- 列宽: 标签20-25, 数字12-15, 日期12, 短码8-10 (必须显式设置!)
- 表头: bold=true, fill=1F4E79, font.color=FFFFFF
- 数字格式: 货币 numFmt='$#,##0', 百分比 numFmt='0.0%',
  零显示为-: numFmt='$#,##0;($#,##0);"-"'
- 公式必须用 formula= 而非硬编码值 (如 formula='SUM(B2:B4)')
- 财务模型色码: 蓝字(0000FF)=输入, 黑字=公式, 绿字(008000)=跨表引用
- 冻结窗格: freeze=A2, 标签色: tabColor=1F4E79
- 斑马纹: 偶数行 fill=D9E2F3
- 避免出现 ### (列太窄), 必须设置足够列宽

【Word .docx 设计标准】
- 层级: Title → Heading1(≥18pt bold) → Heading2(14pt bold) → 正文(11-12pt)
- 字体: 正文用 Calibri/Cambria, 标题用 Cambria/Georgia (两种以内)
- 间距: 用 spaceBefore/spaceAfter, 不用空段落
- 表格: 表头 fill=1F4E79+白字bold, 数字右对齐, 总计行bold+下边框
- 多页文档: 必须加 footer 含 PAGE 字段 (--prop field=page)
- 封面: ≥60%填充(标题+副标题+日期+密级标注), pageBreakBefore 进入正文
- 3+标题时加 TOC (--type toc)
- 引号用弯引号, 范围用 en-dash(–)`,
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filename: "string", force: "boolean" },
  async function office_create(workDir: string, args: Record<string, unknown>): Promise<string> {
    const filename = String(args["filename"]);
    const force = args["force"] !== false;
    const full = resolvePath(workDir, filename);
    try {
      const cliArgs = force ? ['--force'] : [];
      const doc = await oc.create(full, cliArgs);
      _docSessions.set(full, doc);
      const ext = path.extname(filename).toLowerCase();
      const kind = { '.pptx': 'PowerPoint', '.docx': 'Word', '.xlsx': 'Excel' }[ext] || 'Office';
      return `✅ 已创建 ${kind} 文档: ${filename}\n路径: ${full}\n下一步: 使用 office_send 或 office_batch 添加内容\n⚠️ 请遵守工具描述中的设计指南（字号/配色/字体/间距标准）`;
    } catch (e: any) {
      return `(x) 创建失败: ${e.message || e}`;
    }
  },
);

registry.register(
  `向 Office 文档发送单条命令（通过命名管道通信，高性能）。
command: officecli 命令名 (create/add/set/get/query/view/remove/save/close/help)
path: 元素路径 (如 /slide[1], /body/p[1], /Sheet1/A1)
props: JSON 属性字典 (如 {"title":"Hello","color":"red","size":36})
parent: 父元素路径 (add 命令时使用, 如 / 或 /slide[1])
element_type: 元素类型 (add 命令时使用, 如 slide/shape/paragraph/cell/chart/notes/table)

常用属性名: text, font, size, bold, color, fill, align, valign,
  x, y, width, height (带cm单位), background, layout, preset,
  line, name, numFmt, formula, value, width(列宽), freeze, tabColor,
  spaceBefore, spaceAfter, style(Heading1/Normal), listStyle(bullet),
  field(page/numpages), pageBreakBefore, chartType, series1.name,
  series1.values, series1.color, categories

颜色: 不带#的6位HEX, 如 1E2761, FFFFFF, F96167
尺寸: 带单位, 如 2cm, 20cm, 1.5in, 12pt
用法: office_send(filename='deck.pptx', command='add', parent='/', 
                   element_type='slide', props='{"layout":"blank","background":"1E2761"}')`,
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filename: "string", command: "string", path: "string", props: "string", parent: "string", element_type: "string" },
  async function office_send(workDir: string, args: Record<string, unknown>): Promise<string> {
    const filename = String(args["filename"]);
    const command = String(args["command"]);
    const item: any = { command };
    if (args["path"]) item.path = String(args["path"]);
    if (args["parent"]) item.parent = String(args["parent"]);
    if (args["element_type"]) item.type = String(args["element_type"]);
    if (args["props"]) {
      try {
        item.props = JSON.parse(String(args["props"]));
      } catch (e: any) {
        return `(x) props JSON 解析失败: ${e.message}\n请使用合法 JSON，如: {"title":"Hello"}`;
      }
    }
    try {
      const doc = await getOrOpenDoc(workDir, filename);
      const result = await doc.send(item);
      return formatResult(result);
    } catch (e: any) {
      return `(x) 命令执行失败: ${e.message || e}`;
    }
  },
);

registry.register(
  `批量执行 Office 文档命令（一次管道往返执行多条命令，最高性能）。
commands_json: JSON 数组，每个元素是一条 officecli 命令。

每个命令对象的字段:
  command: 命令名 (add/set/get/remove/view 等)
  parent: 父元素路径 (add 时用, 如 / 或 /slide[1])
  type: 元素类型 (add 时用, 如 slide/shape/paragraph/cell/chart)
  path: 元素路径 (set/get 时用, 如 /slide[1]/shape[1])
  props: 属性对象 (如 {"text":"Hello","size":36,"bold":"true"})

⚠️ 注意: batch JSON 中用 "type" 而非 "element_type";
  batch JSON 中 cell 属性用全名: font.color(非color), font.size(非size)

示例: office_batch(filename='data.xlsx', commands_json='
  [{"command":"set","path":"/Sheet1/A1","props":{"value":"Name","bold":"true","font.color":"FFFFFF","fill":"1F4E79"}},
   {"command":"set","path":"/Sheet1/A2","props":{"value":"Alice"}}]')`,
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filename: "string", commands_json: "string" },
  async function office_batch(workDir: string, args: Record<string, unknown>): Promise<string> {
    const filename = String(args["filename"]);
    let items: any[];
    try {
      items = JSON.parse(String(args["commands_json"]));
    } catch (e: any) {
      return `(x) commands_json 解析失败: ${e.message}\n请使用合法 JSON 数组`;
    }
    if (!Array.isArray(items)) return '(x) commands_json 必须是 JSON 数组';
    try {
      const doc = await getOrOpenDoc(workDir, filename);
      const result = await doc.batch(items);
      return `✅ 批量执行 ${items.length} 条命令\n${formatResult(result)}`;
    } catch (e: any) {
      return `(x) 批量执行失败: ${e.message || e}`;
    }
  },
);

registry.register(
  "查看 Office 文档内容（大纲/统计/问题/文本/HTML渲染）。mode: outline|stats|issues|text|html",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filename: "string", mode: "string" },
  async function office_view(workDir: string, args: Record<string, unknown>): Promise<string> {
    const filename = String(args["filename"]);
    const mode = String(args["mode"] || "outline");
    try {
      const doc = await getOrOpenDoc(workDir, filename);
      const result = await doc.send({ command: 'view', mode }, false);
      return formatResult(result);
    } catch (e: any) {
      return `(x) 查看失败: ${e.message || e}`;
    }
  },
);

registry.register(
  "直接执行 officecli CLI 命令（万能后门，适合高级用法和 help 查询）。command: 完整的 officecli 命令行（不含 officecli 前缀）",
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", command: "string" },
  function office_cli(_workDir: string, args: Record<string, unknown>): string {
    const command = String(args["command"]);
    // Resolve binary
    const binary = oc.pipePaths ? 'officecli' : 'officecli'; // just use the name
    const r = spawnSync(binary, command.split(/\s+/).filter(Boolean), {
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    });
    if (r.error) {
      // Try auto-install
      try {
        oc.install();
        const r2 = spawnSync('officecli', command.split(/\s+/).filter(Boolean), {
          encoding: 'utf-8',
          shell: process.platform === 'win32',
        });
        const out2 = ((r2.stdout || '') + (r2.stderr || '')).trim() || '(无输出)';
        return `exit=${r2.status}\n${out2.slice(0, 8000)}`;
      } catch (e: any) {
        return `(x) officecli 不可用: ${e.message || e}`;
      }
    }
    const out = ((r.stdout || '') + (r.stderr || '')).trim() || '(无输出)';
    return `exit=${r.status}\n${out.slice(0, 8000)}`;
  },
);

registry.register(
  `安装、检查或更新 officecli 二进制。
action:
  status      — 检查安装状态和当前版本
  version     — 显示详细版本信息（版本号、路径、文件修改时间）
  install     — 安装 officecli（首次安装或重新安装）
  check_update — 检查是否有新版本可用（对比 GitHub Releases，不安装）
  update      — 更新到最新版本（关闭活跃会话 → 下载安装 → 验证新版本）

用法: office_install(action="status")
      office_install(action="check_update")
      office_install(action="update")`,
  RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", action: "string" },
  async function office_install(_workDir: string, args: Record<string, unknown>): Promise<string> {
    const action = String(args["action"] || "status");

    // ── status: 检查安装状态 ──
    if (action === 'status') {
      const r = spawnSync('officecli', ['--version'], {
        encoding: 'utf-8',
        shell: process.platform === 'win32',
      });
      if (r.status === 0) {
        return `✅ officecli 已安装\n版本: ${r.stdout.trim()}\n路径: ${resolveBinaryPath()}`;
      }
      return '❌ officecli 未安装\n安装命令: office_install(action="install")\n更新命令: office_install(action="update")';
    }

    // ── version: 详细版本信息 ──
    if (action === 'version') {
      const info = getCurrentVersion();
      if (!info) {
        return '❌ officecli 未安装或不可用\n安装命令: office_install(action="install")';
      }
      let fileAge = '';
      try {
        const stat = fs.statSync(info.path);
        const ageDays = Math.floor((Date.now() - stat.mtimeMs) / 86400000);
        fileAge = `\n文件修改时间: ${stat.mtime.toISOString()} (${ageDays} 天前)`;
      } catch { /* */ }
      return `📦 officecli 版本信息\n版本: ${info.version}\n路径: ${info.path}${fileAge}`;
    }

    // ── check_update: 检查是否有新版本 ──
    if (action === 'check_update') {
      const current = getCurrentVersion();
      if (!current) {
        return '❌ officecli 未安装\n请先安装: office_install(action="install")';
      }
      const latest = getLatestVersion();
      if (!latest) {
        return `⚠️ 无法获取最新版本信息（网络问题或 GitHub API 限制）\n当前版本: ${current.version}\n可手动检查: https://github.com/iOfficeAI/OfficeCLI/releases`;
      }
      const cmp = compareVersions(current.version, latest.version);
      if (cmp >= 0) {
        return `✅ 已是最新版本\n当前版本: ${current.version}\n最新版本: ${latest.version}${latest.url ? `\nRelease: ${latest.url}` : ''}`;
      }
      return `🔄 有新版本可用！\n当前版本: ${current.version}\n最新版本: ${latest.version}${latest.url ? `\nRelease: ${latest.url}` : ''}\n\n更新命令: office_install(action="update")`;
    }

    // ── update: 完整更新流程 ──
    if (action === 'update') {
      const before = getCurrentVersion();
      const beforeVer = before?.version || '(未安装)';

      // 1. 关闭所有活跃会话
      const closed = await closeAllSessions();
      const closeMsg = closed.length > 0
        ? `已关闭 ${closed.length} 个活跃文档会话`
        : '无活跃会话需要关闭';

      // 2. 运行安装器（下载最新版本）
      try {
        oc.install();
      } catch (e: any) {
        return `❌ 更新失败: ${e.message || e}\n${closeMsg}\n当前版本: ${beforeVer}`;
      }

      // 3. 验证新版本
      const after = getCurrentVersion();
      const afterVer = after?.version || '(验证失败)';

      // 4. 比较版本
      if (before && after) {
        const cmp = compareVersions(before.version, after.version);
        if (cmp === 0) {
          return `ℹ️ 版本未变化（可能已是最新）\n${closeMsg}\n版本: ${beforeVer} → ${afterVer}`;
        }
        if (cmp > 0) {
          return `⚠️ 版本回退？请检查\n${closeMsg}\n版本: ${beforeVer} → ${afterVer}`;
        }
      }

      return `✅ 更新完成！\n${closeMsg}\n版本: ${beforeVer} → ${afterVer}${after ? `\n路径: ${after.path}` : ''}`;
    }

    // ── install: 安装 ──
    if (action === 'install') {
      try {
        oc.install();
        const after = getCurrentVersion();
        return after
          ? `✅ officecli 安装成功\n版本: ${after.version}\n路径: ${after.path}`
          : '✅ officecli 安装完成（验证失败，请检查 PATH）';
      } catch (e: any) {
        return `❌ 安装失败: ${e.message || e}`;
      }
    }

    return `(x) 未知操作: ${action}\n可用: status, version, install, check_update, update`;
  },
);
