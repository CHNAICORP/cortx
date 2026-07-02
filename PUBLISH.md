# 发布指南

> **当前版本: 1.0.0**

## 包名 vs CLI 命令

| | 包名 | CLI 命令 | 原因 |
|---|------|---------|------|
| PyPI | `ctx` | `ctx` | PyPI `ctx` 可用 |
| npm | `@chnaicorp/ctx` | `ctx` | npm `ctx` 被占，用 scoped 包 |

```bash
pip install ctx                    # Python
npm install -g @chnaicorp/ctx      # TypeScript
ctx                                # 运行（仅 3 字母）
```

---

## 一、PyPI 发布

### 1.1 前置准备

```bash
# 安装发布工具
pip install build twine

# 在 https://pypi.org/manage/account/token/ 创建 API Token
# Token 名: ctx-upload
# 权限: 上传到项目
```

### 1.2 构建 + 上传

```bash
cd C:/ws/harness_agent

# 清理旧构建
rm -rf dist build *.egg-info

# 构建
python -m build

# 检查包内容
tar -tzf dist/ctx-1.0.0.tar.gz | head -20

# 上传到 PyPI
twine upload dist/* -u __token__ -p <YOUR_PYPI_TOKEN>

# 或使用环境变量
export TWINE_USERNAME=__token__
export TWINE_PASSWORD=<YOUR_PYPI_TOKEN>
twine upload dist/*
```

### 1.3 验证安装

```bash
pip install ctx
ctx --help
ctx --no-stream -q "hello"
```

---

## 二、npm 发布

### 2.1 前置准备

```bash
# 在 https://www.npmjs.com 注册账号
# 在 https://www.npmjs.com/settings/<user>/tokens 创建 Access Token
# 类型: Automation (CI/CD)
```

### 2.2 构建 + 上传

```bash
cd C:/ws/harness_agent

# 编译 TypeScript
npx tsc

# 检查包内容
npm pack --dry-run

# 登录 npm
npm login
# 输入用户名/密码/邮箱

# 发布
npm publish
```

### 2.3 验证安装

```bash
npm install -g @chnaicorp/ctx
ctx --no-stream -q "hello"
```

---

## 三、版本更新流程

### 3.1 更新版本号

同步更新 3 个文件的版本号：

```bash
# 当前版本: 1.0.0，以下示例升级到 1.0.1

# pyproject.toml
version = "1.0.1"          # 修改此行

# package.json
"version": "1.0.1"         # 修改此行

# python/cortex_agent/__init__.py
__version__ = "1.0.1"      # 修改此行
```

### 3.2 构建 + 发布双平台

```bash
# 1. Git 提交
git add -A
git commit -m "🔖 v1.0.1: <更新内容>"
git tag v1.0.1
git push --tags

# 2. PyPI
rm -rf dist && python -m build
twine upload dist/*

# 3. npm
npx tsc && npm publish

# 4. 验证
pip install --upgrade ctx && ctx --version
npm install -g @chnaicorp/ctx@latest && ctx --version
```

### 3.3 版本号规范 (SemVer)

| 变更类型 | 版本 | 示例 |
|---------|------|------|
| Bug 修复 | patch (1.0.x) | 1.0.0 → 1.0.1 |
| 新功能 | minor (1.x.0) | 1.0.0 → 1.1.0 |
| 破坏性变更 | major (x.0.0) | 1.0.0 → 2.0.0 |

---

## 四、CI/CD 自动发布（GitHub Actions）

`.github/workflows/publish.yml`：

```yaml
name: Publish
on:
  push:
    tags: ['v*']

jobs:
  pypi:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install build twine && python -m build
      - run: twine upload dist/* -u __token__ -p ${{ secrets.PYPI_TOKEN }}

  npm:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci && npx tsc && npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

---

## 五、常见问题

### Q: 包名 `ctx` 已被占用？
```bash
# PyPI: 修改 pyproject.toml 中 name
name = "ctx-xxx"

# npm: 修改 package.json 中 name
"name": "ctx-xxx"
```

### Q: twine upload 失败 "File already exists"？
每次发布需要新版本号。不能覆盖已发布的版本。

### Q: npm publish 失败 "You cannot publish over the previous version"？
同 PyPI，需要升级版本号。

### Q: 如何撤回错误版本？
- PyPI: `twine upload --skip-existing` 重新构建不同版本
- npm: `npm unpublish @chnaicorp/ctx@1.0.0`（72小时内）
