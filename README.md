# Cortex Agent

安全可控的 AI Agent 运行时 — **Harness Agent 架构 + Agentic Loop 引擎**

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-24+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> **Cortex** = 大脑皮层。如同大脑皮层负责感知推理、血脑屏障严格过滤、海马体持久记忆 — Cortex Agent 将 Agentic Loop（推理）、PolicyEngine（安全）、Memory（记忆）融为一体。

---

## 双语言实现

| | Python | TypeScript |
|---|--------|-----------|
| 位置 | `python/cortex_agent/` | `src/` |
| 工具数 | 43 | 43 |
| 安装 | `pip install cortex-agent` | `npm install -g cortex-agent` |
| CLI 命令 | `ctx` | `ctx` |

---

## 快速开始

```bash
# Python
pip install cortex-agent
ctx --model pro

# TypeScript
npm install -g cortex-agent
ctx --model pro

# 单次查询
ctx -q "用 Python 写斐波那契函数"
```

---

## 设计哲学

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Think   │ →  │  Guard   │ →  │   Act    │ →  │ Reflect  │
│ (LLM流式)│    │(Policy)  │    │(Executor)│    │(步数收敛)│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
```

| 原则 | 说明 |
|------|------|
| **Agent 自主决策** | 不注入行为指令，Agent 从工具结果中自行推理 |
| **完整中介** | 所有工具调用必经 PolicyEngine 4 级审计 |
| **Share-nothing 隔离** | 每实例独立 work_dir / executor / observer |

---

## 项目结构

```
cortex-agent/
├── python/cortex_agent/        # Python 包
│   ├── cortex_agent.py          # Agentic Loop 核心引擎
│   ├── policy.py                # PolicyEngine 安全策略
│   ├── llm.py                   # LLM Provider (DeepSeek/OpenAI)
│   ├── tools.py                 # 核心工具 (25)
│   ├── tools_mcp.py             # MCP 客户端 + 注册表
│   ├── tools_browser.py         # CDP WebSocket 浏览器
│   ├── tools_computer.py        # 桌面控制
│   ├── tools_network.py         # 代理/镜像
│   ├── tools_rag.py             # RAG 知识检索
│   ├── main.py                  # CLI 入口
│   ├── terminal.py              # 流式终端
│   ├── memory.py                # 记忆/会话
│   ├── config.py                # 配置加载
│   └── skills.py                # 技能系统
│
├── src/                         # TypeScript 包
│   ├── core/                    # 核心引擎
│   ├── tools/                   # 工具模块 (7 文件)
│   └── cli/                     # CLI 入口
│
├── cortex_workspace/            # 运行时工作区
├── CORTEX.md                    # 项目知识库
├── pyproject.toml               # Python 包配置
├── package.json                 # npm 包配置
└── tsconfig.json                # TypeScript 配置
```

---

## 43 个工具

| 分类 | 工具 |
|------|------|
| **文件** | `list_directory` `read_file` `write_file` `edit_file` `glob` `grep` `diff_files` `file_ops` `read_json` `csv_query` |
| **执行** | `run_shell_command` `run_python` `execute_sql_query` `python_lint` |
| **网络** | `web_search` `web_fetch` `http_request` `set_proxy` `unset_proxy` `show_proxy` |
| **记忆** | `remember_fact` `recall_fact` `forget_fact` `ask_user` |
| **任务** | `task_create` `task_list` `task_update` |
| **MCP** | `mcp_list_servers` `mcp_list_tools` `mcp_call_tool` `mcp_registry` `mcp_install` `mcp_quick` |
| **浏览器** | `browser_navigate` `browser_snapshot` `browser_screenshot` |
| **桌面** | `computer_screenshot` `computer_click` |
| **镜像** | `pip_mirror` `npm_mirror` |
| **RAG** | `search_knowledge` `rebuild_knowledge_index` |
| **时间** | `get_current_time` |

---

## REPL 命令

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/context` | 上下文容量 + 缓存命中率 |
| `/kb` | 查看知识库 CORTEX.md |
| `/goal [目标]` | 设置/查看持久化目标 |
| `/plan [描述]` | 进入规划模式 |
| `/skills` | 列出所有技能 |
| `/skill <name>` | 调用技能 |
| `/mode [s\|a\|y]` | 切换权限模式 (Shift+Tab) |
| `/model [pro]` | 切换模型 |
| `/tools` | 列出工具 |
| `/trace` `/audit` | 审计追踪 |
| `/memory` | 查看记忆 |
| `/sessions` | 列出会话 |
| `@filename` | 文件引用 |
| `/init` | 初始化项目 |

---

## 权限模式

| 模式 | 行为 |
|------|------|
| `standard` 🛡️ | SAFE 自动 / WRITE 区内 / SYSTEM 需确认 |
| `auto-edit` ✏️ | 自动批准编辑 + SYSTEM 放行 |
| `yolo` ⚠️ | 全部放行 (CI/CD) |

---

## License

MIT
