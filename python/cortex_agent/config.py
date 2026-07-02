"""
配置加载器 — 从 settings.json 读取配置，合并到 AgentConfig

加载优先级（从低到高）:
  1. 代码默认值 (AgentConfig dataclass defaults)
  2. settings.json（项目级: {cwd}/.cortex/settings.json）
  3. settings.json（用户级: ~/.cortex/settings.json）
  4. 环境变量 (CORTEX_API_KEY, CORTEX_MODEL, etc.)
  5. CLI 参数

settings.json 结构:
{
  "model": "flash",
  "provider": "deepseek",
  "providers": {
    "deepseek": {
      "api_key": "sk-...",
      "base_url": "https://api.deepseek.com/v1",
      "models": { "flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro" }
    },
    "openai": {
      "api_key": "sk-...",
      "base_url": "https://api.openai.com/v1",
      "models": { "gpt4": "gpt-4o", "gpt4m": "gpt-4o-mini" }
    }
  },
  "max_steps": 10,
  "work_dir": "./cortex_workspace",
  "loop_timeout": 120,
  "think_timeout": 60,
  "auto_extract_memory": true,
  "memory_enabled": true,
  "sessions_enabled": true
}
"""

import os, json
from typing import Optional


def _find_upwards(filename: str, start: str = None) -> Optional[str]:
    """从 start 向上搜索 filename，返回完整路径或 None。"""
    d = os.path.abspath(start or os.getcwd())
    while True:
        candidate = os.path.join(d, filename)
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def load_settings(project_dir: str = None) -> dict:
    """加载合并后的设置字典。用户级覆盖项目级。"""
    merged = {}

    # 1. 项目级
    proj = _find_upwards(".cortex/settings.json", project_dir or os.getcwd())
    if proj:
        try:
            with open(proj, "r", encoding="utf-8") as f:
                merged.update(json.load(f))
        except Exception:
            pass

    # 2. 用户级 (~)
    user = os.path.join(os.path.expanduser("~"), ".cortex", "settings.json")
    if os.path.isfile(user):
        try:
            with open(user, "r", encoding="utf-8") as f:
                merged.update(json.load(f))
        except Exception:
            pass

    # 3. 环境变量覆盖
    if os.environ.get("CORTEX_API_KEY"):
        merged.setdefault("providers", {})
        provider = merged.get("provider", "deepseek")
        merged["providers"].setdefault(provider, {})
        merged["providers"][provider]["api_key"] = os.environ["CORTEX_API_KEY"]
    if os.environ.get("CORTEX_MODEL"):
        merged["model"] = os.environ["CORTEX_MODEL"]

    return merged


def apply_to_config(config, settings: dict):
    """将 settings dict 应用到 AgentConfig 对象。"""
    from .cortex_agent import LLMProvider

    # Provider 注册
    LLMProvider.setup(
        providers=settings.get("providers"),
        active=settings.get("provider", "deepseek"),
    )

    # API key：先取当前 provider 的 api_key，再取 settings 顶层，再取 config 已有值
    active_provider = LLMProvider.provider_name()
    providers = settings.get("providers", {})
    provider_cfg = providers.get(active_provider, {})
    api_key = provider_cfg.get("api_key", "") or settings.get("api_key", "") or config.api_key
    config.api_key = api_key

    # 简单字段
    for key in ("model", "max_steps", "tool_timeout", "system_prompt",
                "max_context_msgs", "loop_timeout", "think_timeout",
                "work_dir", "memory_dir", "sessions_dir", "skills_dir",
                "memory_enabled", "sessions_enabled", "auto_extract_memory",
                "permission_mode", "permission_remember", "workspace_only",
                "context_limit"):
        if key in settings:
            setattr(config, key, settings[key])


def create_default_settings(path: str) -> dict:
    """在 path 路径创建默认 settings.json。返回写入的 dict。"""
    default = {
        "model": "pro",
        "provider": "deepseek",
        "providers": {
            "deepseek": {
                "api_key": "",
                "base_url": "https://api.deepseek.com/v1",
                "models": {"flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro"},
            }
        },
        "max_steps": 10,
        "loop_timeout": 120,
        "think_timeout": 60,
        "auto_extract_memory": True,
        "memory_enabled": True,
        "sessions_enabled": True,
        "permission_mode": "standard",
        "permission_remember": True,
        "workspace_only": False,
        "context_limit": 1000000,
        "mcpServers": {
            "playwright": {
                "command": "npx",
                "args": ["-y", "@playwright/mcp@latest"],
                "description": "浏览器自动化（Microsoft 官方）"
            },
            "fetch": {
                "command": "python",
                "args": ["-m", "mcp_server_fetch"],
                "description": "HTTP 抓取 + HTML→Markdown"
            },
            "sqlite": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-sqlite"],
                "description": "SQLite 数据库查询"
            },
            "context7": {
                "url": "https://mcp.context7.com/mcp",
                "description": "实时库/框架文档查询"
            }
        }
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(default, f, ensure_ascii=False, indent=2)
    return default
