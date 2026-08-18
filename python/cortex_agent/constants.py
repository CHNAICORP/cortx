"""Cortex Agent — 共享常量与工具函数。

消除跨文件硬编码：User-Agent、路径、MCP 版本、截断/glob helper。
与 TS src/core/constants.ts 对应。
"""
import os
import re
from pathlib import Path

# ── .cortx 目录 ──
CORTX_DIR = ".cortx"


def cortx_home_dir() -> str:
    return str(Path.home() / CORTX_DIR)


def cortx_settings_path() -> str:
    return str(Path.home() / CORTX_DIR / "settings.json")


def cortx_workspace_dir() -> str:
    return str(Path.home() / CORTX_DIR / "workspace")


def cortx_skills_dir(project_dir: str | None = None) -> str:
    base = project_dir or os.getcwd()
    return str(Path(base) / CORTX_DIR / "skills")


# ── User-Agent ──
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
USER_AGENT_SHORT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
PRODUCT_NAME = "cortex-agent"

# ── MCP 客户端版本（统一，消除 "1.0" vs "2.7.0" 不一致）──
MCP_CLIENT_VERSION = "2.9.5"
MCP_CLIENT_INFO = {"name": PRODUCT_NAME, "version": MCP_CLIENT_VERSION}

# ── ANSI 终端色板 ──
ANSI = {
    "RESET": "\x1b[0m",
    "BOLD": "\x1b[1m",
    "DIM": "\x1b[2m",
    "RED": "\x1b[31m",
    "GREEN": "\x1b[32m",
    "YELLOW": "\x1b[33m",
    "BLUE": "\x1b[34m",
    "MAGENTA": "\x1b[35m",
    "CYAN": "\x1b[36m",
    "GRAY": "\x1b[90m",
    "GREEN_BRIGHT": "\x1b[38;5;82m",
    "YELLOW_BRIGHT": "\x1b[38;5;220m",
    "RED_BRIGHT": "\x1b[38;5;196m",
    "DIM_245": "\x1b[38;5;245m",
    "GRAY_240": "\x1b[38;5;240m",
}


# ── 截断 helper（统一 head/tail 比例）──
def truncate_middle(text: str, max_len: int, head_ratio: float = 0.7) -> str:
    """保留首尾、省略中间的截断。"""
    if len(text) <= max_len:
        return text
    head = int(max_len * head_ratio)
    tail = int(max_len * (1 - head_ratio))
    omitted = len(text) - head - tail
    return f"{text[:head]}\n\n[...已截断，省略 {omitted} 字符...]\n\n{text[-tail:]}"


# ── glob → regex 转义 ──
def glob_to_regex(pattern: str, anchored: bool = True) -> re.Pattern:
    """将 glob 通配符转为正则表达式。* → .*，? → .，其他正则元字符转义。"""
    re_str = re.sub(r"[.+^${}()|[\]\\]", lambda m: "\\" + m.group(), pattern)
    re_str = re_str.replace("*", ".*").replace("?", ".")
    if anchored:
        re_str = "^" + re_str + "$"
    return re.compile(re_str)


# ── 递归目录遍历 ──
_SKIP_DIRS = {".", "node_modules", "__pycache__", "dist", ".git", "cortex_workspace"}


def walk_dir(dir_path: str, cb, max_results: int = 5000) -> int:
    """递归遍历目录，跳过 .开头 / node_modules / __pycache__ / dist。
    cb(full_path, entry) 对每个文件调用。
    """
    import os
    count = 0

    def _walk(d: str):
        nonlocal count
        if count >= max_results:
            return
        try:
            entries = os.listdir(d)
        except (OSError, PermissionError):
            return
        for name in entries:
            if count >= max_results:
                return
            if name.startswith(".") or name in _SKIP_DIRS:
                continue
            full = os.path.join(d, name)
            if os.path.isdir(full):
                _walk(full)
            else:
                cb(full, name)
                count += 1

    _walk(dir_path)
    return count
