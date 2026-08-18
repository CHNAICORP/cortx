# Cortx — Harness Agent 架构 + Agentic Loop 运行时

## 命名由来

**Cortex** = 大脑皮层 — 负责感知、推理、决策。Cortex Agent 不是简单的工具调用链，而是**有安全边界、有记忆、能反思的自主推理层**。

```
大脑架构                     Cortex Agent
────────                   ────────────
大脑皮层 → 感知·推理·决策    Agentic Loop (Think→Guard→Act→Reflect)
血脑屏障 → 严格过滤          PolicyEngine (完整中介·4级审计)
海马体   → 长期记忆          Memory + Sessions (跨会话持久化)
运动皮层 → 动作输出          69 工具 (文件/Shell/浏览器/MCP/技能/子代理...)
```

**Cortex** 是 **Harness Agent** 架构范式的具体实现，如同 Ubuntu 之于 Linux。

## 设计哲学

1. **Agent 自主决策** — Harness 提供工具和安全边界，Agent 自行思考如何解决问题。
   Harness **不注入行为指令**。Agent 从工具结果中自主推理，自行判断何时收敛。

2. **完整中介** — 所有工具调用必须经过 PolicyEngine 审计，每条工具结果如实返回。
   安全违规以工具错误形式呈现（如 `(x) [Policy 拦截] ...`），Agent 自行解读并调整。

3. **Share-nothing 隔离** — 每个 Agent 实例持有独立的 work_dir / executor / observer。

4. **结构性约束** — 循环检测（相同工具+参数连续 5 次自动停止）防止卡死。

## Agentic Loop

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Think   │ →  │  Guard   │ →  │   Act    │ →  │ Reflect  │
│ (LLM流式)│    │(Policy)  │    │(Executor)│    │(步数收敛)│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
       ↑                                              │
       └──────────────────────────────────────────────┘
```

## 双语言实现

| | Python | TypeScript |
|---|--------|-----------|
| 位置 | `python/cortex_agent/` | `src/` |
| 工具数 | 69 | 69 |
| 安装 | `pip install cortx` | `npm install -g @chnaicorp/cortx` |

## 核心扩展系统

### 技能系统 (Skills)
- 7 个内置技能 + `.cortx/skills/` 下的自定义技能
- `list_skills` / `use_skill` / `skill_install` / `skill_remove`
- 从 GitHub 安装：`skill_install(source="owner/repo")`

### 子代理 (Subagents)
- `spawn_subagent` — 单个子代理（支持工具过滤 + 技能预加载）
- `spawn_subagents` — 并行 fan-out（Promise.all / ThreadPoolExecutor）
- 上下文隔离，返回结果摘要

### MCP 服务器（预配置）
- **chrome-devtools** — 29 个浏览器工具（npx 自动下载）
- **cua-driver** — 55 个桌面控制工具（原生二进制）
- `mcp_session_start` / `mcp_session_call` / `mcp_session_stop` 持久化会话

### 上下文管理
- `max_result_chars: 50000` — 工具结果截断上限
- `compress_threshold: 6000` — 压缩阈值（4x 提升）
- `max_steps: 0` — 无限步数 + 循环检测兜底

## 69 个工具

| 模块 | 工具 |
|------|------|
| `tools.py` | `list_directory` `read_file` `write_file` `edit_file` `glob` `grep` `execute_sql_query` `run_shell_command` `run_python` `get_current_time` `web_search` `web_fetch` `remember_fact` `recall_fact` `forget_fact` `ask_user` `python_lint` `task_create` `task_list` `task_update` `diff_files` `http_request` `file_ops` `read_json` `csv_query` `list_tools` `run_background_command` `check_server_status` `stop_background_process` `list_background_processes` `spawn_subagent` `spawn_subagents` `list_skills` `use_skill` `skill_install` `skill_remove` `git_status` `git_diff` `git_commit` `git_branch` `git_log` |
| `tools_mcp.py` | `mcp_list_servers` `mcp_list_tools` `mcp_call_tool` `mcp_registry` `mcp_install` `mcp_quick` `mcp_session_start` `mcp_session_call` `mcp_session_list_tools` `mcp_session_stop` |
| `tools_browser.py` | `browser_navigate` `browser_snapshot` `browser_screenshot` |
| `tools_computer.py` | `computer_screenshot` `computer_click` |
| `tools_network.py` | `set_proxy` `unset_proxy` `show_proxy` `pip_mirror` `npm_mirror` |
| `tools_rag.py` | `search_knowledge` `rebuild_knowledge_index` |
| `tools_office.py` | `office_create` `office_send` `office_batch` `office_view` `office_cli` `office_install` |

## 安全机制

- **完整中介**: 所有工具调用必经 `PolicyEngine.audit()`（4 级判决: ALLOW/WARN/CONFIRM/DENY）
- **SSRF 防护**: 10 段 CIDR 内网 IP 拦截 + IPv4-mapped IPv6 检测
- **SQL 注入防护**: 词边界正则 + 仅 SELECT + 游标级行数限制
- **Python 沙箱**: 子进程隔离 + 16 条逃逸检测规则
- **路径穿越防护**: 工作目录归一化 + 所有路径参数名检测
- **自适应熔断**: 同一 capability 连续 5 次违规 → 自动暂停
- **循环检测**: 相同工具+参数连续 5 次调用 → 自动停止
- **share-nothing 实例隔离**: 多 Agent 并行不串扰

## 用法

```bash
# Python
pip install cortx
ctx --model pro

# TypeScript
npm install -g @chnaicorp/cortx
ctx --model pro

# REPL 命令
/help     /context   /tools     /skills   /skill
/mode     /model     /memory    /sessions  /trace
```

## 库使用

```python
from cortex_agent import CortexAgent, AgentConfig

agent = CortexAgent(AgentConfig(model="pro", work_dir="./my_ws"))
agent.run("write a fibonacci function")
```
