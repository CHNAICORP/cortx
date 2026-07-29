"""
Cortex Agent Office 文档工具 — 基于 OfficeCLI SDK
═══════════════════════════════════════════════════════════════

通过 OfficeCLI 二进制 + 命名管道通信，提供高性能 Office 文档操作：
  Word (.docx) / Excel (.xlsx) / PowerPoint (.pptx)

工具列表:
  office_create    — 创建空白 Office 文档
  office_send      — 发送单条命令（通过命名管道，高性能）
  office_batch     — 批量执行命令（一次管道往返）
  office_view      — 查看文档内容（大纲/统计/文本/HTML）
  office_cli       — 直接执行 officecli CLI 命令（万能后门）
  office_install   — 安装/检查 officecli 二进制

首次使用时自动检测并安装 officecli 二进制（零配置）。
"""

import os
import json
import shutil
import subprocess
import platform
from datetime import datetime

from .cortex_agent import registry, RiskLevel, Capability
from . import officecli_sdk as oc


# ══════════════════════════════════════════════════════════════
# 文档会话缓存 — work_dir 内打开的文档保持 resident 活跃
# ══════════════════════════════════════════════════════════════

_doc_sessions: dict = {}  # {filepath: Document}

# ── OfficeCLI GitHub Releases API ──
_GITHUB_RELEASES_API = "https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/latest"


def _resolve_path(work_dir: str, filename: str) -> str:
    """将相对路径解析为绝对路径（基于 work_dir）。"""
    if os.path.isabs(filename):
        return filename
    return os.path.join(work_dir, filename)


def _get_or_open_doc(work_dir: str, filename: str) -> oc.Document:
    """获取已打开的文档会话，或打开一个已存在的文档。"""
    full = _resolve_path(work_dir, filename)
    if full not in _doc_sessions:
        _doc_sessions[full] = oc.open(full)
    return _doc_sessions[full]


def _format_result(result) -> str:
    """将 SDK 返回值格式化为字符串。"""
    if isinstance(result, (dict, list)):
        text = json.dumps(result, ensure_ascii=False, indent=2)
        if len(text) > 8000:
            text = text[:8000] + "\n... (已截断)"
        return text
    if isinstance(result, str):
        if len(result) > 8000:
            return result[:8000] + "\n... (已截断)"
        return result
    return str(result)


# ══════════════════════════════════════════════════════════════
# 版本工具函数
# ══════════════════════════════════════════════════════════════

def _get_current_version() -> dict | None:
    """获取当前已安装的 officecli 版本号和路径。"""
    binary = oc._resolve_binary("officecli")
    if oc._runs_ok(binary):
        try:
            r = oc._run_cli(binary, ["--version"])
            version = r.stdout.strip()
            return {"version": version, "path": binary}
        except Exception:
            pass
    return None


def _resolve_binary_path() -> str:
    """解析 officecli 二进制路径。"""
    return oc._resolve_binary("officecli")


def _get_latest_version() -> dict | None:
    """从 GitHub Releases API 获取最新版本号。"""
    import urllib.request
    try:
        req = urllib.request.Request(_GITHUB_RELEASES_API,
                                     headers={"User-Agent": "cortex-agent"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            tag = (data.get("tag_name") or "").lstrip("v")
            if tag:
                return {"version": tag, "url": data.get("html_url", "")}
    except Exception:
        pass
    return None


def _compare_versions(current: str, latest: str) -> int:
    """比较两个语义化版本号。
    返回 1 表示 latest > current, 0 表示相等, -1 表示 latest < current。
    """
    def parse_ver(v: str):
        parts = v.lstrip("v").split(".")
        return [int("".join(c for c in p if c.isdigit()) or "0") for p in parts]
    a = parse_ver(current)
    b = parse_ver(latest)
    max_len = max(len(a), len(b))
    for i in range(max_len):
        va = a[i] if i < len(a) else 0
        vb = b[i] if i < len(b) else 0
        if va > vb:
            return 1
        if va < vb:
            return -1
    return 0


def _close_all_sessions() -> list:
    """关闭所有活跃的文档会话（更新前必须执行，避免文件锁冲突）。"""
    closed = []
    for fp, doc in list(_doc_sessions.items()):
        try:
            doc.close()
            closed.append(fp)
        except Exception:
            pass
    _doc_sessions.clear()
    return closed


# ══════════════════════════════════════════════════════════════
# 工具注册
# ══════════════════════════════════════════════════════════════

@registry.register(
    "创建空白 Office 文档（Word .docx / Excel .xlsx / PowerPoint .pptx）。\n"
    "首次使用时自动检测并安装 officecli 二进制（零配置）。\n"
    "\n"
    "═══ Office 设计指南（必须遵守）═══\n"
    "\n"
    "创建文档前，先选择设计方向，然后在 office_send/office_batch 中设置对应属性。\n"
    "\n"
    "【PowerPoint .pptx 设计标准】\n"
    "- 尺寸: 宽屏 33.87×19.05cm, 边距≥1.27cm, 块间距≥0.76cm\n"
    "- 字号: 标题≥36pt bold, 副标题≥20pt, 正文≥18pt, 注释≥10pt\n"
    "- 字体: 标题用 Georgia/Arial Black, 正文用 Calibri/Arial (两种以内)\n"
    "- 配色(选一): Midnight Executive(1E2761/CADCFC/FFFFFF/333333/8899BB) |\n"
    "  Coral Energy(F96167/F9E795/2F3C7E/333333/8B7E6A) |\n"
    "  Charcoal Minimal(36454F/F2F2F2/212121/333333/7A8A94) |\n"
    "  Ocean Gradient(065A82/1C7293/21295C/2B3A4E/6B8FAA)\n"
    "  格式: Primary(60-70%)/Secondary/Accent/Text/Muted\n"
    "- 每页必须有非文字视觉元素(shape/chart/icon), 不能只有文字\n"
    "- 标题用 shape(非placeholder), layout=blank, 显式设置 x/y/width/height\n"
    "- 封面: 深色背景+居中44pt标题+18pt副标题\n"
    "- 数据页: 左2/3图表+右1/3评论卡片(roundRect背景)\n"
    "- KPI页: 60pt大数字+≤5词副标签, 用shape不用chart\n"
    "- 每页加 speaker notes: --type notes --prop text=...\n"
    "- 禁止: 标题下装饰线, 圆角卡片左侧色条, emoji做图标\n"
    "\n"
    "【Excel .xlsx 设计标准】\n"
    "- 字体: 全工作簿统一 Arial 或 Calibri\n"
    "- 列宽: 标签20-25, 数字12-15, 日期12, 短码8-10 (必须显式设置!)\n"
    "- 表头: bold=true, fill=1F4E79, font.color=FFFFFF\n"
    "- 数字格式: 货币 numFmt='$#,##0', 百分比 numFmt='0.0%',\n"
    "  零显示为-: numFmt='$#,##0;($#,##0);\"-\"'\n"
    "- 公式必须用 formula= 而非硬编码值 (如 formula='SUM(B2:B4)')\n"
    "- 财务模型色码: 蓝字(0000FF)=输入, 黑字=公式, 绿字(008000)=跨表引用\n"
    "- 冻结窗格: freeze=A2, 标签色: tabColor=1F4E79\n"
    "- 斑马纹: 偶数行 fill=D9E2F3\n"
    "- 避免出现 ### (列太窄), 必须设置足够列宽\n"
    "\n"
    "【Word .docx 设计标准】\n"
    "- 层级: Title → Heading1(≥18pt bold) → Heading2(14pt bold) → 正文(11-12pt)\n"
    "- 字体: 正文用 Calibri/Cambria, 标题用 Cambria/Georgia (两种以内)\n"
    "- 间距: 用 spaceBefore/spaceAfter, 不用空段落\n"
    "- 表格: 表头 fill=1F4E79+白字bold, 数字右对齐, 总计行bold+下边框\n"
    "- 多页文档: 必须加 footer 含 PAGE 字段 (--prop field=page)\n"
    "- 封面: ≥60%填充(标题+副标题+日期+密级标注), pageBreakBefore 进入正文\n"
    "- 3+标题时加 TOC (--type toc)\n"
    "- 引号用弯引号, 范围用 en-dash(–)\n"
    "用法: office_create(filename='report.pptx')\n"
    "      office_create(filename='data.xlsx', force=True)",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def office_create(work_dir: str, filename: str, force: bool = True) -> str:
    full = _resolve_path(work_dir, filename)
    try:
        args = ["--force"] if force else []
        doc = oc.create(full, *args)
        _doc_sessions[full] = doc
        ext = os.path.splitext(filename)[1].lower()
        kind = {".pptx": "PowerPoint", ".docx": "Word", ".xlsx": "Excel"}.get(ext, "Office")
        return (f"✅ 已创建 {kind} 文档: {filename}\n"
                f"路径: {full}\n"
                f"下一步: 使用 office_send 或 office_batch 添加内容\n"
                f"⚠️ 请遵守工具描述中的设计指南（字号/配色/字体/间距标准）")
    except oc.OfficeCliError as e:
        return f"(x) 创建失败: {e}"


@registry.register(
    "向 Office 文档发送单条命令（通过命名管道通信，高性能）。\n"
    "command: officecli 命令名 (create/add/set/get/query/view/remove/save/close/help)\n"
    "path: 元素路径 (如 /slide[1], /body/p[1], /Sheet1/A1)\n"
    "props: JSON 格式的属性字典 (如 {\"title\":\"Hello\",\"color\":\"red\",\"size\":36})\n"
    "parent: 父元素路径 (add 命令时使用, 如 / 或 /slide[1])\n"
    "element_type: 元素类型 (add 命令时使用, 如 slide/shape/paragraph/cell/chart/notes/table)\n"
    "\n"
    "常用属性名: text, font, size, bold, color, fill, align, valign,\n"
    "  x, y, width, height (带cm单位), background, layout, preset,\n"
    "  line, name, numFmt, formula, value, width(列宽), freeze, tabColor,\n"
    "  spaceBefore, spaceAfter, style(Heading1/Normal), listStyle(bullet),\n"
    "  field(page/numpages), pageBreakBefore, chartType, series1.name,\n"
    "  series1.values, series1.color, categories\n"
    "\n"
    "颜色: 不带#的6位HEX, 如 1E2761, FFFFFF, F96167\n"
    "尺寸: 带单位, 如 2cm, 20cm, 1.5in, 12pt\n"
    "用法: office_send(filename='deck.pptx', command='add', parent='/', \n"
    "                   element_type='slide', props='{\"layout\":\"blank\",\"background\":\"1E2761\"}')",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def office_send(work_dir: str, filename: str, command: str,
                path: str = "", props: str = "", parent: str = "",
                element_type: str = "") -> str:
    full = _resolve_path(work_dir, filename)
    try:
        doc = _get_or_open_doc(work_dir, filename)
    except oc.OfficeCliError as e:
        return f"(x) 无法打开文档: {e}"

    item = {"command": command}
    if path:
        item["path"] = path
    if parent:
        item["parent"] = parent
    if element_type:
        item["type"] = element_type
    if props:
        try:
            item["props"] = json.loads(props)
        except json.JSONDecodeError as e:
            return f"(x) props JSON 解析失败: {e}\n请使用合法 JSON，如: {{\"title\":\"Hello\"}}"

    try:
        result = doc.send(item)
        return _format_result(result)
    except oc.OfficeCliError as e:
        return f"(x) 命令执行失败: {e}"


@registry.register(
    "批量执行 Office 文档命令（一次管道往返执行多条命令，最高性能）。\n"
    "commands_json: JSON 数组，每个元素是一条 officecli 命令。\n"
    "\n"
    "每个命令对象的字段:\n"
    "  command: 命令名 (add/set/get/remove/view 等)\n"
    "  parent: 父元素路径 (add 时用, 如 / 或 /slide[1])\n"
    "  type: 元素类型 (add 时用, 如 slide/shape/paragraph/cell/chart)\n"
    "  path: 元素路径 (set/get 时用, 如 /slide[1]/shape[1])\n"
    "  props: 属性对象 (如 {\"text\":\"Hello\",\"size\":36,\"bold\":\"true\"})\n"
    "\n"
    "⚠️ 注意: batch JSON 中用 \"type\" 而非 \"element_type\";\n"
    "  batch JSON 中 cell 属性用全名: font.color(非color), font.size(非size)\n"
    "\n"
    "示例: office_batch(filename='data.xlsx', commands_json='\n"
    "  [{\"command\":\"set\",\"path\":\"/Sheet1/A1\",\"props\":{\"value\":\"Name\",\"bold\":\"true\",\"font.color\":\"FFFFFF\",\"fill\":\"1F4E79\"}},\n"
    "   {\"command\":\"set\",\"path\":\"/Sheet1/A2\",\"props\":{\"value\":\"Alice\"}}]')",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def office_batch(work_dir: str, filename: str, commands_json: str) -> str:
    full = _resolve_path(work_dir, filename)
    try:
        doc = _get_or_open_doc(work_dir, filename)
    except oc.OfficeCliError as e:
        return f"(x) 无法打开文档: {e}"

    try:
        items = json.loads(commands_json)
    except json.JSONDecodeError as e:
        return f"(x) commands_json 解析失败: {e}\n请使用合法 JSON 数组"

    if not isinstance(items, list):
        return "(x) commands_json 必须是 JSON 数组"

    try:
        result = doc.batch(items)
        count = len(items)
        return f"✅ 批量执行 {count} 条命令\n{_format_result(result)}"
    except oc.OfficeCliError as e:
        return f"(x) 批量执行失败: {e}"


@registry.register(
    "查看 Office 文档内容（大纲/统计/问题/文本/HTML渲染）。\n"
    "mode: outline(大纲) | stats(统计) | issues(问题) | text(纯文本) | html(HTML渲染)\n"
    "用法: office_view(filename='deck.pptx', mode='outline')\n"
    "      office_view(filename='report.docx', mode='text')",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def office_view(work_dir: str, filename: str, mode: str = "outline") -> str:
    full = _resolve_path(work_dir, filename)
    try:
        doc = _get_or_open_doc(work_dir, filename)
    except oc.OfficeCliError as e:
        return f"(x) 无法打开文档: {e}"

    try:
        result = doc.send({"command": "view", "mode": mode}, as_json=False)
        return _format_result(result)
    except oc.OfficeCliError as e:
        return f"(x) 查看失败: {e}"


@registry.register(
    "直接执行 officecli CLI 命令（万能后门，适合高级用法和 help 查询）。\n"
    "command: 完整的 officecli 命令行 (不含 officecli 前缀)\n"
    "用法: office_cli(command='help pptx shape')\n"
    "      office_cli(command='validate deck.pptx')",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def office_cli(work_dir: str, command: str) -> str:
    # 解析 officecli 二进制路径
    binary = oc._resolve_binary("officecli")
    if not oc._runs_ok(binary):
        try:
            oc._ensure_binary("officecli", auto_install=True)
            binary = oc._resolve_binary("officecli")
        except oc.OfficeCliError as e:
            return f"(x) officecli 不可用: {e}"

    # 拆分命令参数
    import shlex
    is_win = platform.system() == "Windows"
    try:
        argv = shlex.split(command, posix=not is_win)
    except ValueError as e:
        return f"(x) 命令解析失败: {e}"

    if not argv:
        return "(x) 空命令"

    try:
        r = oc._run_cli(binary, argv)
        out = (r.stdout + r.stderr).strip() or "(无输出)"
        if len(out) > 8000:
            out = out[:8000] + "\n... (已截断)"
        return f"exit={r.returncode}\n{out}"
    except oc.OfficeCliError as e:
        return f"(x) 执行失败: {e}"


@registry.register(
    "安装、检查或更新 officecli 二进制。\n"
    "action:\n"
    "  status       — 检查安装状态和当前版本\n"
    "  version      — 显示详细版本信息（版本号、路径、文件修改时间）\n"
    "  install      — 安装 officecli（首次安装或重新安装）\n"
    "  check_update — 检查是否有新版本可用（对比 GitHub Releases，不安装）\n"
    "  update       — 更新到最新版本（关闭活跃会话 → 下载安装 → 验证新版本）\n"
    "\n"
    "用法: office_install(action='status')\n"
    "      office_install(action='check_update')\n"
    "      office_install(action='update')",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def office_install(work_dir: str, action: str = "status") -> str:
    # ── status: 检查安装状态 ──
    if action == "status":
        binary = oc._resolve_binary("officecli")
        if oc._runs_ok(binary):
            try:
                r = oc._run_cli(binary, ["--version"])
                version = r.stdout.strip()
            except Exception:
                version = "(未知)"
            return (f"✅ officecli 已安装\n"
                    f"版本: {version}\n"
                    f"路径: {binary}")
        else:
            install_dir = oc._install_dir_candidate("officecli")
            return (f"❌ officecli 未安装\n"
                    f"默认安装位置: {install_dir or '(未知)'}\n"
                    f"安装命令: office_install(action='install')\n"
                    f"更新命令: office_install(action='update')")

    # ── version: 详细版本信息 ──
    if action == "version":
        info = _get_current_version()
        if not info:
            return "❌ officecli 未安装或不可用\n安装命令: office_install(action='install')"
        file_age = ""
        try:
            stat = os.stat(info["path"])
            mtime = datetime.fromtimestamp(stat.st_mtime)
            age_days = (datetime.now() - mtime).days
            file_age = f"\n文件修改时间: {mtime.strftime('%Y-%m-%d %H:%M:%S')} ({age_days} 天前)"
        except Exception:
            pass
        return (f"📦 officecli 版本信息\n"
                f"版本: {info['version']}\n"
                f"路径: {info['path']}{file_age}")

    # ── check_update: 检查是否有新版本 ──
    if action == "check_update":
        current = _get_current_version()
        if not current:
            return "❌ officecli 未安装\n请先安装: office_install(action='install')"
        latest = _get_latest_version()
        if not latest:
            return (f"⚠️ 无法获取最新版本信息（网络问题或 GitHub API 限制）\n"
                    f"当前版本: {current['version']}\n"
                    f"可手动检查: https://github.com/iOfficeAI/OfficeCLI/releases")
        cmp = _compare_versions(current["version"], latest["version"])
        if cmp >= 0:
            url_part = f"\nRelease: {latest['url']}" if latest.get("url") else ""
            return (f"✅ 已是最新版本\n"
                    f"当前版本: {current['version']}\n"
                    f"最新版本: {latest['version']}{url_part}")
        url_part = f"\nRelease: {latest['url']}" if latest.get("url") else ""
        return (f"🔄 有新版本可用！\n"
                f"当前版本: {current['version']}\n"
                f"最新版本: {latest['version']}{url_part}\n"
                f"\n更新命令: office_install(action='update')")

    # ── update: 完整更新流程 ──
    if action == "update":
        before = _get_current_version()
        before_ver = before["version"] if before else "(未安装)"

        # 1. 关闭所有活跃会话
        closed = _close_all_sessions()
        close_msg = (f"已关闭 {len(closed)} 个活跃文档会话"
                     if closed else "无活跃会话需要关闭")

        # 2. 运行安装器（下载最新版本）
        try:
            oc.install()
        except oc.OfficeCliError as e:
            return f"❌ 更新失败: {e}\n{close_msg}\n当前版本: {before_ver}"

        # 3. 验证新版本
        after = _get_current_version()
        after_ver = after["version"] if after else "(验证失败)"

        # 4. 比较版本
        if before and after:
            cmp = _compare_versions(before["version"], after["version"])
            if cmp == 0:
                return (f"ℹ️ 版本未变化（可能已是最新）\n"
                        f"{close_msg}\n"
                        f"版本: {before_ver} → {after_ver}")
            if cmp > 0:
                return (f"⚠️ 版本回退？请检查\n"
                        f"{close_msg}\n"
                        f"版本: {before_ver} → {after_ver}")

        path_part = f"\n路径: {after['path']}" if after else ""
        return (f"✅ 更新完成！\n"
                f"{close_msg}\n"
                f"版本: {before_ver} → {after_ver}{path_part}")

    # ── install: 安装 ──
    if action == "install":
        try:
            oc.install()
            after = _get_current_version()
            if after:
                return f"✅ officecli 安装成功\n版本: {after['version']}\n路径: {after['path']}"
            return "✅ officecli 安装完成（验证失败，请检查 PATH）"
        except oc.OfficeCliError as e:
            return f"❌ 安装失败: {e}"

    return f"(x) 未知操作: {action}\n可用: status, version, install, check_update, update"
