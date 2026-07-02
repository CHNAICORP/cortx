# Contributing to Cortex Agent

欢迎贡献！Cortex Agent 支持 Python 和 TypeScript 双语言。

## 开发环境

```bash
git clone https://github.com/<user>/cortex-agent.git
cd cortex-agent

# Python
pip install -e .
ctx --model pro

# TypeScript
npm install
npx tsc
node dist/cli/main.js
```

## 项目结构

```
python/cortex_agent/     # Python 包 (相对导入)
src/                     # TypeScript 包 (node16 模块)
```

## 代码规范

- **每文件 ≤ 800 行** — Python 和 TypeScript 统一标准
- **Python 3.10+** — 使用现代语法，包内相对导入
- **TypeScript 5.x + Node 24** — 严格模式，`module: node16`

## 添加新工具

### Python

```python
# 在 python/cortex_agent/tools_xxx.py 中
from .cortex_agent import registry, RiskLevel, Capability

@registry.register("工具描述", risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def my_tool(work_dir: str, ...) -> str:
    ...
```

### TypeScript

```typescript
// 在 src/tools/xxx.ts 中
import { registry } from "../core/registry.js";
import { RiskLevel, Capability } from "../core/types.js";

registry.register("工具描述", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function my_tool(workDir: string, args: Record<string, unknown>): string {
    ...
  },
);
```

## 添加自定义技能

在 `.cortex/skills/` 创建 `.md` 文件：

```markdown
# Skill Name
> 简短描述

[category: development]

---
详细的 prompt 内容...
```

## 双语言同步

两个版本功能平价（43 工具），新增工具需同时在 Python 和 TypeScript 实现。

## License

MIT — 贡献即同意以 MIT 协议授权。
