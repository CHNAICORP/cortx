"""
Cortex Agent 网络工具 — 代理配置 + 包管理器镜像
═══════════════════════════════════════════════════

set_proxy / unset_proxy / show_proxy / pip_mirror / npm_mirror
"""

import os, sys, subprocess
from .cortex_agent import registry, RiskLevel, Capability

_PROXY_STORE = {}

_PIP_MIRRORS = {
    "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "aliyun":   "https://mirrors.aliyun.com/pypi/simple",
    "tencent":  "https://mirrors.cloud.tencent.com/pypi/simple",
    "ustc":     "https://pypi.mirrors.ustc.edu.cn/simple",
    "douban":   "https://pypi.douban.com/simple",
    "huawei":   "https://repo.huaweicloud.com/repository/pypi/simple",
    "default":  "https://pypi.org/simple",
}

_NPM_MIRRORS = {
    "taobao":   "https://registry.npmmirror.com",
    "tencent":  "https://mirrors.cloud.tencent.com/npm/",
    "huawei":   "https://repo.huaweicloud.com/repository/npm/",
    "default":  "https://registry.npmjs.org",
}


# ══════════════════════════════════════════════════════════════
# HTTP 代理工具
# ══════════════════════════════════════════════════════════════

_PROXY_STORE = {}  # 模块级代理状态存储


@registry.register(
    "设置 HTTP/HTTPS/SOCKS 代理。用于加速网络访问、解决超时问题。\n"
    "用法: set_proxy(http=\"http://127.0.0.1:7897\", https=\"http://127.0.0.1:7897\")\n"
    "示例: set_proxy(http=\"http://127.0.0.1:7890\", socks=\"socks5://127.0.0.1:7891\")",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def set_proxy(work_dir: str, http: str = "", https: str = "", all_proxy: str = "",
               socks: str = "", no_proxy: str = "localhost,127.0.0.1,.local") -> str:
    import os as _os
    global _PROXY_STORE
    changed = []
    if http:
        _os.environ["HTTP_PROXY"] = http
        _os.environ["http_proxy"] = http
        _PROXY_STORE["http"] = http
        changed.append(f"HTTP  → {http}")
    if https:
        _os.environ["HTTPS_PROXY"] = https
        _os.environ["https_proxy"] = https
        _PROXY_STORE["https"] = https
        changed.append(f"HTTPS → {https}")
    if all_proxy:
        _os.environ["ALL_PROXY"] = all_proxy
        _os.environ["all_proxy"] = all_proxy
        _PROXY_STORE["all"] = all_proxy
        changed.append(f"ALL   → {all_proxy}")
    if socks:
        _os.environ["ALL_PROXY"] = socks
        _os.environ["all_proxy"] = socks
        _PROXY_STORE["socks"] = socks
        changed.append(f"SOCKS → {socks}")
    if no_proxy:
        _os.environ["NO_PROXY"] = no_proxy
        _os.environ["no_proxy"] = no_proxy
        _PROXY_STORE["no_proxy"] = no_proxy
    if not changed:
        return ("(未指定代理地址)\n\n"
                "用法示例:\n"
                "  set_proxy(http=\"http://127.0.0.1:7897\", https=\"http://127.0.0.1:7897\")\n"
                "  set_proxy(socks=\"socks5://127.0.0.1:7897\", all_proxy=\"socks5://127.0.0.1:7897\")")
    # 同时写入 shell 命令提示
    shell_hint = ("\n\n=== 终端手动设置 (Windows) ===\n"
                  f"PowerShell: $env:HTTP_PROXY=\"{http or https or ''}\"; $env:HTTPS_PROXY=\"{https or http or ''}\"\n"
                  f"CMD:        set http_proxy={http or https or ''}\n"
                  f"            set https_proxy={https or http or ''}\n"
                  "\n=== 终端手动设置 (Linux/Mac) ===\n"
                  f"export https_proxy={https or http or ''} http_proxy={http or https or ''}")
    return f"代理已设置 (当前进程 + 子进程生效):\n" + "\n".join(f"  {c}" for c in changed) + shell_hint


@registry.register(
    "取消所有 HTTP 代理设置。",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def unset_proxy(work_dir: str) -> str:
    import os as _os
    global _PROXY_STORE
    for key in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
                "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"):
        _os.environ.pop(key, None)
    _PROXY_STORE.clear()
    return ("代理已取消。\n\n"
            "终端手动取消:\n"
            "  PowerShell: Remove-Item Env:HTTP_PROXY, Env:HTTPS_PROXY\n"
            "  CMD:        set http_proxy=\n"
            "  Linux/Mac:  unset http_proxy https_proxy")


@registry.register(
    "查看当前代理设置状态。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def show_proxy(work_dir: str) -> str:
    import os as _os
    lines = []
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        val = _os.environ.get(key, "")
        if val:
            lines.append(f"  {key} = {val}")
    if not lines:
        return "(未设置代理)"
    return "当前代理设置:\n" + "\n".join(lines)


# ══════════════════════════════════════════════════════════════
# 镜像源切换工具
# ══════════════════════════════════════════════════════════════

_PIP_MIRRORS = {
    "tsinghua": "https://pypi.tuna.tsinghua.edu.cn/simple",
    "aliyun":   "https://mirrors.aliyun.com/pypi/simple",
    "tencent":  "https://mirrors.cloud.tencent.com/pypi/simple",
    "ustc":     "https://pypi.mirrors.ustc.edu.cn/simple",
    "douban":   "https://pypi.douban.com/simple",
    "huawei":   "https://repo.huaweicloud.com/repository/pypi/simple",
    "default":  "https://pypi.org/simple",
}

_NPM_MIRRORS = {
    "taobao":   "https://registry.npmmirror.com",
    "tencent":  "https://mirrors.cloud.tencent.com/npm/",
    "huawei":   "https://repo.huaweicloud.com/repository/npm/",
    "default":  "https://registry.npmjs.org",
}


@registry.register(
    "切换 pip 镜像源以加速 Python 包下载。\n"
    "用法: pip_mirror(action=\"list\"|\"set\"|\"reset\", mirror=\"tsinghua\")\n"
    "可用镜像: tsinghua, aliyun, tencent, ustc, douban, huawei, default",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def pip_mirror(work_dir: str, action: str = "list", mirror: str = "") -> str:
    import subprocess
    if action == "list":
        lines = ["可用 pip 镜像源:\n"]
        for name, url in _PIP_MIRRORS.items():
            marker = " (官方)" if name == "default" else ""
            lines.append(f"  ● {name}{marker}: {url}")
        lines.append(f"\n当前配置: 可通过 'pip config get global.index-url' 查看")
        return "\n".join(lines)
    if action == "set":
        if mirror not in _PIP_MIRRORS:
            return f"(x) 未知镜像: {mirror}\n可用: {', '.join(_PIP_MIRRORS.keys())}"
        url = _PIP_MIRRORS[mirror]
        try:
            r = subprocess.run([sys.executable, "-m", "pip", "config", "set",
                               "global.index-url", url],
                              capture_output=True, text=True, timeout=10)
            return (f"pip 镜像已切换 → {mirror}\n"
                    f"  URL: {url}\n"
                    f"  {r.stdout.strip()}\n\n"
                    f"临时使用: pip install -i {url} <package>\n"
                    f"恢复官方: pip_mirror(action=\"reset\")")
        except Exception as e:
            return (f"pip config 命令失败: {e}\n\n"
                    f"请手动执行:\n"
                    f"  pip config set global.index-url {url}\n\n"
                    f"或临时使用:\n"
                    f"  pip install -i {url} <package>")
    if action == "reset":
        try:
            r = subprocess.run([sys.executable, "-m", "pip", "config", "unset",
                               "global.index-url"],
                              capture_output=True, text=True, timeout=10)
            return f"pip 镜像已恢复官方源\n  {r.stdout.strip()}"
        except Exception as e:
            return (f"恢复失败: {e}\n\n请手动执行:\n"
                    f"  pip config unset global.index-url")
    return f"(x) 未知操作: {action}\n可用: list, set, reset"


@registry.register(
    "切换 npm 镜像源以加速 Node.js 包下载。\n"
    "用法: npm_mirror(action=\"list\"|\"set\"|\"reset\", mirror=\"taobao\")\n"
    "可用镜像: taobao, tencent, huawei, default",
    risk=RiskLevel.WRITE, capability=Capability.FS_WRITE)
def npm_mirror(work_dir: str, action: str = "list", mirror: str = "") -> str:
    import subprocess
    if action == "list":
        lines = ["可用 npm 镜像源:\n"]
        for name, url in _NPM_MIRRORS.items():
            marker = " (官方)" if name == "default" else ""
            lines.append(f"  ● {name}{marker}: {url}")
        try:
            r = subprocess.run(["npm", "config", "get", "registry"],
                              capture_output=True, text=True, timeout=5)
            lines.append(f"\n当前配置: {r.stdout.strip()}")
        except Exception:
            pass
        return "\n".join(lines)
    if action == "set":
        if mirror not in _NPM_MIRRORS:
            return f"(x) 未知镜像: {mirror}\n可用: {', '.join(_NPM_MIRRORS.keys())}"
        url = _NPM_MIRRORS[mirror]
        try:
            r = subprocess.run(["npm", "config", "set", "registry", url],
                              capture_output=True, text=True, timeout=10)
            return (f"npm 镜像已切换 → {mirror}\n"
                    f"  URL: {url}\n\n"
                    f"临时使用: npm install --registry={url} <package>\n"
                    f"恢复官方: npm_mirror(action=\"reset\")")
        except Exception as e:
            return (f"npm config 命令失败: {e}\n\n请手动执行:\n"
                    f"  npm config set registry {url}")
    if action == "reset":
        try:
            r = subprocess.run(["npm", "config", "delete", "registry"],
                              capture_output=True, text=True, timeout=10)
            return f"npm 镜像已恢复官方源"
        except Exception as e:
            return (f"恢复失败: {e}\n\n请手动执行:\n  npm config delete registry")
    return f"(x) 未知操作: {action}\n可用: list, set, reset"
