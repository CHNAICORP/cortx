# Cortx

安全可控的 AI Agent 运行时 — **Harness Agent 架构 + Agentic Loop 引擎**

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![TypeScript](https://img.shields.io/badge/typescript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org/)
[![PyPI](https://img.shields.io/pypi/v/cortx.svg)](https://pypi.org/project/cortx/)
[![npm](https://img.shields.io/npm/v/@chnaicorp/cortx.svg)](https://www.npmjs.com/package/@chnaicorp/cortx)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> **Cortex** = 大脑皮层。如同大脑皮层负责感知推理、血脑屏障严格过滤、海马体持久记忆 — Cortex Agent 将 Agentic Loop（推理）、PolicyEngine（安全）、Memory（记忆）融为一体。

---

## 双语言实现

| | Python | TypeScript |
|---|--------|-----------|
| 位置 | `python/cortex_agent/` | `src/` |
| 工具数 | 69 | 69 |
| 安装 | `pip install cortx` | `npm install -g @chnaicorp/cortx` |
| CLI 命令 | `ctx` | `ctx` |

> 💡 **PyPI: `pip install cortx`，npm: `npm install -g @chnaicorp/cortx`。运行只需 `ctx`**

---

## 快速开始

```bash
# Python
pip install cortx
ctx

# TypeScript
npm install -g @chnaicorp/cortx
ctx                         # 交互 REPL
ctx -q "hello"              # 单次查询
ctx --model pro             # 指定模型
```

---

## 核心能力

### 🛠 69 个内置工具

| 分类 | 工具 |
|------|------|
| **文件** | `list_directory` `read_file` `write_file` `edit_file` `glob` `grep` `diff_files` `file_ops` `read_json` `csv_query` |
| **执行** | `run_shell_command` `run_python` `execute_sql_query` `python_lint` `run_background_command` `check_server_status` `stop_background_process` `list_background_processes` |
| **网络** | `web_search` `web_fetch` `http_request` `set_proxy` `unset_proxy` `show_proxy` `pip_mirror` `npm_mirror` |
| **Git** | `git_status` `git_diff` `git_commit` `git_branch` `git_log` |
| **MCP** | `mcp_list_servers` `mcp_list_tools` `mcp_call_tool` `mcp_registry` `mcp_install` `mcp_quick` `mcp_session_start` `mcp_session_call` `mcp_session_list_tools` `mcp_session_stop` |
| **浏览器** | `browser_navigate`（等待页面加载完成）`browser_snapshot`（获取页面文本）`browser_screenshot` |
| **桌面** | `computer_screenshot` `computer_click` |
| **Office** | `office_create` `office_send` `office_batch` `office_view` `office_cli` `office_install` |
| **技能** | `list_skills` `use_skill` `skill_install` `skill_remove` |
| **子代理** | `spawn_subagent`（单个+工具过滤+技能预加载）`spawn_subagents`（并行 fan-out） |
| **记忆/任务** | `remember_fact` `recall_fact` `forget_fact` `ask_user` `task_create` `task_list` `task_update` |
| **元工具** | `list_tools` `get_current_time` `search_knowledge` `rebuild_knowledge_index` |

### 🎓 技能系统 (Skills)

技能是可复用的专家级指引模板，能为特定任务提供专业方法论：

```bash
# 查看所有技能
ctx -q "调用 list_skills 列出你的技能"

# 从 GitHub 安装新技能
ctx -q '用 skill_install 从 GitHub 安装 alchaincyf/huashu-design'

# 加载技能并按其指引工作
ctx -q '用 use_skill 加载 code-review 技能，然后审查 src/core/registry.ts'
```

- **7 个内置技能**：code-review、refactor、test-writer、doc-writer、debug、explain、architect
- **自定义技能**：放在 `.cortx/skills/<name>/SKILL.md`，自动发现注册
- **技能安装**：`skill_install(source="owner/repo")` 从 GitHub 下载，自动注册立即可用
- **YAML frontmatter** 支持 + 递归子目录扫描

### 🤖 子代理系统 (Subagents)

参考智谱 Coding Agent Subagents 设计，主 agent 可派遣子代理执行独立任务：

```bash
# 并行派遣多个子代理
ctx -q '用 spawn_subagents 并行派遣2个子代理：
  子代理1用 code-review 技能审查安全性
  子代理2统计项目 .ts 文件数量'
```

- **并行执行**：`spawn_subagents` 用 `Promise.all`(TS) / `ThreadPoolExecutor`(Python) 并发
- **工具过滤**：`tools="read_file,grep,glob"` 限制子代理可用工具
- **技能预加载**：`skill="code-review"` 子代理启动前注入技能指引
- **进度显示**：`⚡ 派遣 N 个子代理...` + `└ [idx/total] ▶/✓` 实时状态
- **上下文隔离**：子代理独立上下文，返回结果摘要，不污染主对话

### 🔌 MCP 服务器（预配置开箱即用）

安装后即可使用，无需手动配置：

| MCP 服务器 | 工具数 | 用途 | 启动方式 |
|-----------|--------|------|---------|
| **chrome-devtools** | 29 | 浏览器导航/截图/DOM/性能分析 | `npx` 自动下载 |
| **cua-driver** | 55 | 桌面截图/点击/键盘/应用管理/窗口控制 | `cua-driver mcp` |

```bash
# 用 MCP 控制桌面
ctx -q '用 cua-driver MCP 查看运行的应用和屏幕尺寸'

# 用 MCP 控制浏览器
ctx -q '用 chrome-devtools MCP 打开 example.com 并获取页面内容'
```

Agent 自主完成：发现 MCP 注册表 → 列出工具方法 → 选择合适工具 → 调用并获取结果 → 清理会话。

### 🧠 上下文管理优化

| 参数 | 值 | 说明 |
|------|-----|------|
| `max_result_chars` | 50000 | 工具结果截断上限（1M 上下文模型下仅占 1.25%） |
| `compress_threshold` | 6000 | 工具结果压缩阈值（绝大多数结果完整保留） |
| `compact_input_pct` | 85% | 上下文达 85% 时才触发 compact |
| `max_steps` | 0（无限）| Agent 自主决定何时完成，循环检测防止卡死 |

### 🛡 验证策略（文本优先）

文本模型（DeepSeek/GLM）无法识别图片，Agent 优先使用文本验证：
- 页面验证：`browser_snapshot()` 获取页面文本（非截图）
- 服务验证：`check_server_status()` HTTP 健康检查（自动重试 3 次）
- 代码验证：`run_shell_command` 运行测试/编译
- 截图循环检测：连续截图 3+ 次自动注入警告

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
cortx/
├── src/                         # TypeScript 源码
│   ├── core/                    # 核心引擎 (loop, registry, types, skills, tool_context, policy, llm, hooks, memory_store)
│   ├── tools/                   # 工具模块 (11 文件: file, exec, net, memory, mcp, browser, proxy, subagent, git, office, skills)
│   └── cli/                     # CLI 入口 + 终端显示
│
├── python/cortex_agent/         # Python 源码
│   ├── cortex_agent.py          # Agentic Loop 核心引擎
│   ├── tools.py                 # 核心工具 (41)
│   ├── tools_mcp.py             # MCP 客户端 + 注册表 + 会话管理
│   ├── tools_browser.py         # CDP 浏览器 (导航等待+文本快照)
│   ├── tools_computer.py        # 桌面控制
│   ├── tools_network.py         # 代理/镜像
│   ├── tools_office.py          # Office 文档
│   ├── tools_rag.py             # RAG 知识检索
│   ├── skills.py                # 技能系统
│   ├── config.py                # 配置加载
│   └── main.py                  # CLI 入口
│
├── dist/                        # 编译产物 (npm 发布)
├── bin/                         # CLI 入口脚本
├── .cortx/                      # 项目配置 + skills (gitignored)
├── CORTEX.md                    # 项目知识库
├── PUBLISH.md                   # 发布指南
├── pyproject.toml               # Python 包配置
├── package.json                 # npm 包配置
└── tsconfig.json                # TypeScript 配置
```

---

## REPL 命令

| 命令 | 功能 |
|------|------|
| `/help` | 显示帮助 |
| `/context` | 上下文容量 + 缓存命中率 |
| `/tools` | 列出所有工具 |
| `/skills` | 列出所有技能 |
| `/skill <name>` | 调用技能 |
| `/mode [s\|a\|y]` | 切换权限模式 (Shift+Tab) |
| `/model [pro]` | 切换模型 |
| `/memory` | 查看记忆 |
| `/sessions` | 列出会话 |
| `/trace` `/audit` | 审计追踪 |
| `@filename` | 文件引用 |

---

## 权限模式

| 模式 | 行为 |
|------|------|
| `standard` 🛡️ | SAFE 自动 / WRITE 区内 / SYSTEM 需确认 |
| `auto` ✏️ | 自动批准编辑 + SYSTEM 放行 |
| `yolo` ⚠️ | 全部放行 (CI/CD) |

---

## License

MIT
