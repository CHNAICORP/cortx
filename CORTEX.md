# Cortx — Harness Agent 架构 + Agentic Loop 运行时

## 命名由来

**Cortex** = 大脑皮层 — 负责感知、推理、决策。Cortex Agent 不是简单的工具调用链，而是**有安全边界、有记忆、能反思的自主推理层**。

```
大脑架构                     Cortex Agent
────────                   ────────────
大脑皮层 → 感知·推理·决策    Agentic Loop (Think→Guard→Act→Reflect)
血脑屏障 → 严格过滤          PolicyEngine (完整中介·4级审计)
海马体   → 长期记忆          Memory + Sessions (跨会话持久化)
运动皮层 → 动作输出          43 工具 (文件/Shell/浏览器/MCP...)
```

**Cortex** 是 **Harness Agent** 架构范式的具体实现，如同 Ubuntu 之于 Linux。

## 设计哲学

1. **Agent 自主决策** — Harness 提供工具和安全边界，Agent 自行思考如何解决问题。
   Harness **不注入行为指令**。Agent 从工具结果中自主推理，自行判断何时收敛。

2. **完整中介** — 所有工具调用必须经过 PolicyEngine 审计，每条工具结果如实返回。
   安全违规以工具错误形式呈现（如 `(x) [Policy 拦截] ...`），Agent 自行解读并调整。

3. **Share-nothing 隔离** — 每个 Agent 实例持有独立的 work_dir / executor / observer。

4. **结构性约束** — 步数上限、超时等机制是 Harness 的结构性边界。

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
| 工具数 | 43 | 43 |
| 总行数 | ~3,700 | ~1,500 |
| 安装 | `pip install` | `npm install` |

## 项目结构

```
python/cortex_agent/          # Python 包
├── cortex_agent.py  (740行)  — Agentic Loop 核心引擎
├── policy.py        (240行)  — PolicyEngine 安全策略
├── llm.py           (184行)  — LLM Provider
├── tools.py         (581行)  — 核心工具 (25)
├── tools_mcp.py     (460行)  — MCP 客户端 + 15 注册表
├── tools_browser.py (260行)  — CDP WebSocket 浏览器
├── tools_computer.py (90行)  — 桌面控制
├── tools_network.py (227行)  — 代理/镜像
├── tools_rag.py     (132行)  — RAG 知识检索
├── main.py          (425行)  — CLI 入口
├── terminal.py      (148行)  — 流式终端
├── memory.py        (236行)  — 记忆/会话
├── config.py        (163行)  — 配置加载
└── skills.py        (225行)  — 技能系统

src/                          # TypeScript 包
├── core/                     — 核心引擎 (types/registry/policy/llm/loop)
├── tools/                    — 工具模块 (file/net/exec/memory/mcp/browser/proxy)
└── cli/                      — CLI 入口

cortex_workspace/             — Agent 运行时工作区
.cortex/                      — 项目配置 (settings.json + skills/)
```

## 43 个工具

| 模块 | 工具 |
|------|------|
| `tools.py` | `list_directory` `read_file` `write_file` `edit_file` `glob` `grep` `execute_sql_query` `run_shell_command` `run_python` `get_current_time` `web_search` `web_fetch` `remember_fact` `recall_fact` `forget_fact` `ask_user` `python_lint` `task_create` `task_list` `task_update` `diff_files` `http_request` `file_ops` `read_json` `csv_query` |
| `tools_mcp.py` | `mcp_list_servers` `mcp_list_tools` `mcp_call_tool` `mcp_registry` `mcp_install` `mcp_quick` |
| `tools_browser.py` | `browser_navigate` `browser_snapshot` `browser_screenshot` |
| `tools_computer.py` | `computer_screenshot` `computer_click` |
| `tools_network.py` | `set_proxy` `unset_proxy` `show_proxy` `pip_mirror` `npm_mirror` |
| `tools_rag.py` | `search_knowledge` `rebuild_knowledge_index` |

## 安全机制

- **完整中介**: 所有工具调用必经 `PolicyEngine.audit()`（4 级判决: ALLOW/WARN/CONFIRM/DENY）
- **SSRF 防护**: 10 段 CIDR 内网 IP 拦截 + IPv4-mapped IPv6 检测
- **SQL 注入防护**: 词边界正则 + 仅 SELECT + 游标级行数限制
- **Python 沙箱**: 子进程隔离 + 16 条逃逸检测规则
- **路径穿越防护**: 工作目录归一化 + 所有路径参数名检测
- **自适应熔断**: 同一 capability 连续 3 次违规 → 自动暂停
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
/help     /context   /kb        /goal     /plan
/skills   /skill     /mode      /model    /tools
/trace    /audit     /memory    /sessions  /reset
```

## 库使用

```python
from cortex_agent import CortexAgent, AgentConfig

agent = CortexAgent(AgentConfig(model="pro", work_dir="./my_ws"))
agent.run("write a fibonacci function")
```
