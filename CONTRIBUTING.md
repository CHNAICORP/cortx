# Contributing to Cortex Agent

欢迎贡献！以下是参与指南。

## 开发环境

```bash
git clone https://github.com/<user>/cortex-agent.git
cd cortex-agent
pip install -r requirements.txt
```

## 项目规范

- **每文件 ≤ 800 行** — 保持模块小而专注
- **Python 3.10+** — 使用现代语法
- **零外部 Agent 框架依赖** — 核心引擎自包含

## 模块分类

| 层 | 文件 | 职责 |
|---|------|------|
| 引擎层 | `cortex_agent.py` `policy.py` `llm.py` | Agentic Loop / 安全 / LLM |
| 工具层 | `tools*.py` | 按能力域拆分 |
| 交互层 | `main.py` `terminal.py` | CLI / 终端 |
| 持久层 | `memory.py` `config.py` `skills.py` | 状态 / 配置 / 技能 |

## 添加新工具

1. 选择合适的 `tools_*.py` 模块（或新建）
2. 使用 `@registry.register()` 装饰器注册
3. 指定 `risk` 和 `capability`
4. 在 `policy.py` 的 `PATH_PARAMS` 中注册路径参数名

```python
@registry.register(
    "工具描述",
    risk=RiskLevel.SAFE,
    capability=Capability.FS_READ)
def my_tool(work_dir: str, ...) -> str:
    ...
```

## 添加新技能

在 `.cortex/skills/` 创建 `.md` 文件：

```markdown
# Skill Name
> 简短描述

[category: development]

---
详细的 prompt 内容...
```

## 提交规范

- 提交信息使用中文或英文均可
- 涉及安全相关修改请在 PR 中标注

## License

MIT — 贡献即同意以 MIT 协议授权。
