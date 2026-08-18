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
  "max_steps": 0,
  "work_dir": "./cortex_workspace",
  "loop_timeout": 0,
  "think_timeout": 600,
  "max_rounds": 0,
  "checkpoint_interval": 5,
  "retry_max": 3,
  "retry_base_delay": 2,
  "auto_extract_memory": true,
  "memory_enabled": true,
  "sessions_enabled": true
}
"""

import os, json
from typing import Optional


def _smart_merge(base: dict, override: dict):
    """智能合并：override 中的非空值覆盖 base，空值不覆盖。
    
    注意: 0 和 False 是有效值，不应被视为"空"。
    只有 None 和空字符串/空列表/空字典才跳过。
    """
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _smart_merge(base[k], v)
        elif v is None or v == "" or v == [] or v == {}:
            continue  # 空值不覆盖
        else:
            base[k] = v


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
    proj = _find_upwards(".cortx/settings.json", project_dir or os.getcwd())
    if proj:
        try:
            with open(proj, "r", encoding="utf-8") as f:
                merged.update(json.load(f))
        except Exception:
            pass

    # 2. 用户级 (~) — 智能合并：非空值覆盖，空值不覆盖
    user = os.path.join(os.path.expanduser("~"), ".cortx", "settings.json")
    if os.path.isfile(user):
        try:
            with open(user, "r", encoding="utf-8") as f:
                user_settings = json.load(f)
            _smart_merge(merged, user_settings)
        except Exception:
            pass

    # 4. 首次运行：如果没有任何配置，自动创建全局模板
    if not merged and not os.environ.get("CORTEX_API_KEY"):
        os.makedirs(os.path.dirname(user), exist_ok=True)
        template = {
            "model": "pro",
            "provider": "deepseek",
            "providers": {
                "deepseek": {
                    "api_key": "",
                    "base_url": "https://api.deepseek.com/v1",
                    "models": {"flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro"}
                },
                "openai": {
                    "api_key": "",
                    "base_url": "https://api.openai.com/v1",
                    "models": {
                        "5.4": "gpt-5.4", "5.4-mini": "gpt-5.4-mini",
                        "5.2": "gpt-5.2", "4.1": "gpt-4.1",
                        "4o": "gpt-4o", "4o-mini": "gpt-4o-mini",
                    }
                },
                "glm": {
                    "api_key": "",
                    "base_url": "https://open.bigmodel.cn/api/paas/v4",
                    "models": {
                        "5.2": "glm-5.2", "5.1": "glm-5.1",
                        "turbo": "glm-5-turbo", "4.7": "glm-4.7",
                        "4.7-flash": "glm-4.7-flash", "4-long": "glm-4-long",
                    }
                },
                "anthropic": {
                    "api_key": "",
                    "base_url": "https://api.anthropic.com",
                    "models": {
                        "fable": "claude-fable-5",
                        "mythos": "claude-mythos-5",
                        "sonnet": "claude-sonnet-5",
                        "opus": "claude-opus-4-8",
                        "opus-pro": "claude-opus-4-7",
                        "haiku": "claude-haiku-4-5",
                    }
                }
            },
            "max_steps": 0,
            "context_limit": 0,
            "max_tokens": 0,
            "max_input_tokens": 0,
            # ── ContextGovernor 可调参数 ──
            "compress_threshold": 6000,
            "compress_head": 2400,
            "compress_tail": 1600,
            "safety_margin": 4096,
            "input_warn_pct": 80,
            "input_force_pct": 90,
            "compact_input_pct": 85,
            "compact_keep_recent": 12,
            # ── ToolExecutor 可调参数 ──
            "max_result_chars": 50000,
            # ── Memory 注入控制 ──
            "memory_inject_count": 30,
            "permission_mode": "standard",
            "auto_extract_memory": True,
            "memory_enabled": True,
            "sessions_enabled": True,
        }
        with open(user, "w", encoding="utf-8") as f:
            json.dump(template, f, ensure_ascii=False, indent=2)
        print(f"\n  📝 首次运行: 已创建全局配置 {user}")
        print(f"  ⚙️  请在 providers.deepseek.api_key 填入你的 API Key")
        print(f"  📖 同时也支持项目级配置: .cortex/settings.json\n")
        merged.update(template)

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
                "context_limit", "max_tokens", "max_input_tokens",
                "compress_threshold", "compress_head", "compress_tail",
                "safety_margin", "input_warn_pct", "input_force_pct",
                "max_result_chars", "memory_inject_count",
                "max_rounds", "checkpoint_interval", "retry_max",
                "retry_base_delay",
                "compact_input_pct", "compact_keep_recent"):
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
            },
            "glm": {
                "api_key": "",
                "base_url": "https://open.bigmodel.cn/api/paas/v4",
                "models": {},
            },
            "anthropic": {
                "api_key": "",
                "base_url": "https://api.anthropic.com",
                "models": {
                    "fable": "claude-fable-5",
                    "mythos": "claude-mythos-5",
                    "sonnet": "claude-sonnet-5",
                    "opus": "claude-opus-4-8",
                    "opus-pro": "claude-opus-4-7",
                    "haiku": "claude-haiku-4-5",
                },
            },
        },
        "web_search": {
            "provider": "duckduckgo",       # duckduckgo | brave | serpapi | tavily
            "brave_api_key": "",             # Brave Search API key (https://brave.com/search/api/)
            "serpapi_api_key": "",           # SerpAPI key (https://serpapi.com/)
            "tavily_api_key": "",            # Tavily API key (https://tavily.com/)
            "max_results": 5,
            "timeout": 10,
        },
        "max_steps": 0,
        "loop_timeout": 0,
        "think_timeout": 600,
        "max_rounds": 0,
        "checkpoint_interval": 5,
        "retry_max": 5,
        "retry_base_delay": 2,
        "auto_extract_memory": True,
        "memory_enabled": True,
        "sessions_enabled": True,
        "permission_mode": "standard",
        "permission_remember": True,
        "workspace_only": False,
        "context_limit": 0,
        "max_tokens": 0,
        "max_input_tokens": 0,
        # ── ContextGovernor 可调参数 (0=使用默认值) ──
        "compress_threshold": 6000,
        "compress_head": 2400,
        "compress_tail": 1600,
        "safety_margin": 4096,
        "input_warn_pct": 80,
        "input_force_pct": 90,
        "compact_input_pct": 85,
        "compact_keep_recent": 12,
        # ── ToolExecutor 可调参数 ──
        "max_result_chars": 50000,
        # ── Memory 注入控制 ──
        "memory_inject_count": 30,
        "mcpServers": {
            "chrome-devtools": {
                "command": "npx",
                "args": ["-y", "chrome-devtools-mcp@latest"],
                "description": "Chrome DevTools — 浏览器导航/截图/DOM/性能分析"
            },
            "cua-driver": {
                "command": "cua-driver",
                "args": ["mcp"],
                "description": "桌面控制 — 截图/点击/键盘/拖拽/滚动/应用管理"
            },
            "fetch": {
                "command": "python",
                "args": ["-m", "mcp_server_fetch"],
                "description": "HTTP 抓取 + HTML→Markdown"
            },
            "memory": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-memory"],
                "description": "持久化知识图谱记忆系统"
            },
            "sequential-thinking": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
                "description": "多步推理与思维链增强"
            },
            "filesystem": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
                "description": "安全文件系统操作 — 读写/列表/搜索"
            },
            "sqlite": {
                "command": "uvx",
                "args": ["mcp-server-sqlite", "--db-path", "agent.db"],
                "description": "SQLite 数据库查询（官方 Python 实现）"
            },
            "context7": {
                "command": "npx",
                "args": ["-y", "@upstash/context7-mcp"],
                "description": "实时库/框架文档查询"
            }
        }
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    
    # 写入纯净的 settings.json（去除注释）
    clean_default = {k: v for k, v in default.items()}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean_default, f, ensure_ascii=False, indent=2)
    
    # 写入带注释的 settings.example.jsonc 作为文档
    example_path = path.replace(".json", ".example.jsonc")
    example_content = '''{
  // ── 模型配置 ──
  "model": "pro",                            // 使用的模型别名（见 providers.<provider>.models）
  "provider": "deepseek",                    // 当前激活的提供商
  "providers": {
    "deepseek": {
      "api_key": "",                          // 填入你的 DeepSeek API key
      "base_url": "https://api.deepseek.com/v1",
      "models": {
        "flash": "deepseek-v4-flash",         // 快速模型（适合简单任务）
        "pro": "deepseek-v4-pro"              // 强力模型（适合复杂任务）
      }
    },
    "glm": {
      "api_key": "",                          // 填入你的智谱 AI API key
      "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "models": {}
    },
    "anthropic": {
      "api_key": "",                          // 填入你的 Anthropic API key
      "base_url": "https://api.anthropic.com",
      "models": {
        "fable": "claude-fable-5",            // Fable 5 — 最强旗舰 (1M 上下文)
        "mythos": "claude-mythos-5",          // Mythos 5 — 新一代推理 (1M 上下文)
        "sonnet": "claude-sonnet-5",          // Sonnet 5 — 均衡高效 (1M 上下文)
        "opus": "claude-opus-4-8",            // Opus 4.8 — 顶级编码 (200K)
        "opus-pro": "claude-opus-4-7",        // Opus 4.7 (200K)
        "haiku": "claude-haiku-4-5"           // Haiku 4.5 — 快速轻量 (200K)
      }
    }
  },
  "web_search": {
    "provider": "duckduckgo",                 // duckduckgo | brave | serpapi | tavily
    "brave_api_key": "",                      // Brave Search API key
    "serpapi_api_key": "",                    // SerpAPI key
    "tavily_api_key": "",                     // Tavily API key
    "max_results": 5,                         // 搜索结果数量
    "timeout": 10                             // 搜索超时（秒）
  },
  
  // ── Agentic Loop 控制 ──
  "max_steps": 0,                             // 0=无限步数（支持 24h 连续运行）
  "max_rounds": 0,                            // 0=无限轮数（用于 --long 模式）
  "checkpoint_interval": 5,                  // 每 N 步保存一次断点
  "retry_max": 5,                             // 工具调用失败重试次数
  "retry_base_delay": 2,                      // 重试基础延迟（秒）
  "loop_timeout": 0,                          // 0=无超时（支持 24h 连续运行）
  "think_timeout": 600,                       // LLM 思考超时（秒）
  
  // ── 权限模式 ──
  "permission_mode": "standard",              // standard | auto | yolo
  "permission_remember": true,                // 记住用户确认的权限（本次会话）
  "workspace_only": false,                    // 严格限制工作区外操作
  
  // ── 内存/会话 ──
  "memory_enabled": true,                     // 启用长期记忆
  "auto_extract_memory": true,                // 自动从对话中提取记忆
  "sessions_enabled": true,                   // 启用会话管理
  "memory_inject_count": 30,                  // 注入到上下文的记忆条目数
  
  // ── 上下文控制 ──
  "context_limit": 0,                         // 0=自动计算（安全余量+safety_margin）
  "max_tokens": 0,                            // 0=使用模型默认值
  "max_input_tokens": 0,                      // 0=自动计算
  "compress_threshold": 6000,                 // 工具结果压缩阈值（字符数），超过则保留首尾
  "compress_head": 2400,                      // 压缩时保留的头部字符数
  "compress_tail": 1600,                      // 压缩时保留的尾部字符数
  "safety_margin": 4096,                      // 输入 Token 安全余量
  "input_warn_pct": 80,                       // 超过此百分比发出警告
  "input_force_pct": 90,                      // 超过此百分比强制压缩
  "compact_input_pct": 85,                    // 输入 token 达此百分比时触发 compact（缓存友好：平时零触碰历史）
  "compact_keep_recent": 12,                  // compact 时保留的最近消息条数
  
  // ── 工具执行 ──
  "max_result_chars": 2000,                   // 工具输出最大字符数（超过截断）
  "tool_timeout": 0,                          // 0=不设置超时
  
  // ── MCP 服务器配置 ──
  // 这 6 个纯软件可跑的 MCP 默认启用，其他 12 个通过 mcp_install(server="xxx") 按需安装
  "mcpServers": {
    "fetch": {
      "command": "python",                     // 需 pip install mcp-server-fetch
      "args": ["-m", "mcp_server_fetch"],
      "description": "HTTP 抓取 + HTML→Markdown"
    },
    "memory": {
      "command": "npx",                        // 需 Node.js
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "description": "持久化知识图谱记忆系统"
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      "description": "多步推理与思维链增强"
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "description": "安全文件系统操作 — 读写/列表/搜索"
    },
    "sqlite": {
      "command": "uvx",                        // 需 uv (pip install uv)
      "args": ["mcp-server-sqlite", "--db-path", "agent.db"],
      "description": "SQLite 数据库查询（官方 Python 实现）"
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "description": "实时库/框架文档查询"
    }
  }
}
'''
    with open(example_path, "w", encoding="utf-8") as f:
        f.write(example_content)
    
    return default
