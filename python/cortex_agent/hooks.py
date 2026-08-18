"""
Hooks System — 生命周期钩子

支持 PreToolUse / PostToolUse 两个生命周期事件。
钩子可以：
  - PreToolUse: 阻止工具执行（返回非零退出码）
  - PostToolUse: 注入附加信息到工具结果

配置在 settings.json 的 "hooks" 字段中：
{
  "hooks": {
    "PreToolUse": [
      {"pattern": "run_shell_command", "command": "echo 'About to run shell'"}
    ],
    "PostToolUse": [
      {"pattern": "write_file", "command": "echo 'File written'"}
    ]
  }
}

与 TS hooks.ts 对应
"""

import subprocess
import re
import os
import platform
from typing import Dict, List, Optional, Tuple

HookEvent = str  # "PreToolUse" | "PostToolUse"


class HookConfig:
    """钩子配置"""
    def __init__(self, pattern: str, command: str, timeout: int = 30):
        self.pattern = pattern
        self.command = command
        self.timeout = timeout


class HookContext:
    """钩子执行上下文"""
    def __init__(self, tool_name: str, args: dict, work_dir: str, result: str = ""):
        self.tool_name = tool_name
        self.args = args
        self.work_dir = work_dir
        self.result = result


class HookResult:
    """钩子执行结果"""
    def __init__(self, block: bool = False, message: str = "", append: str = ""):
        self.block = block
        self.message = message
        self.append = append


class HookManager:
    """钩子管理器"""

    def __init__(self):
        self.hooks: Dict[str, List[HookConfig]] = {
            "PreToolUse": [],
            "PostToolUse": [],
        }
        self._enabled = True

    def load_from_config(self, config: dict) -> None:
        """从配置加载钩子"""
        if not config or not isinstance(config, dict):
            return
        hooks_cfg = config.get("hooks")
        if not hooks_cfg or not isinstance(hooks_cfg, dict):
            return

        for event in ("PreToolUse", "PostToolUse"):
            hook_list = hooks_cfg.get(event)
            if not isinstance(hook_list, list):
                continue
            self.hooks[event] = []
            for h in hook_list:
                if not isinstance(h, dict):
                    continue
                pattern = h.get("pattern")
                command = h.get("command")
                if not isinstance(pattern, str) or not isinstance(command, str):
                    continue
                timeout = h.get("timeout", 30)
                self.hooks[event].append(HookConfig(pattern, command, timeout))

    def set_enabled(self, enabled: bool) -> None:
        self._enabled = enabled

    def is_enabled(self) -> bool:
        return self._enabled

    @property
    def count(self) -> int:
        return len(self.hooks["PreToolUse"]) + len(self.hooks["PostToolUse"])

    def _match_pattern(self, pattern: str, tool_name: str) -> bool:
        """匹配工具名称与 glob 模式"""
        if pattern == "*":
            return True
        regex = "^" + re.escape(pattern).replace(r"\*", ".*") + "$"
        return bool(re.match(regex, tool_name))

    def _build_env(self, ctx: HookContext) -> dict:
        """构建环境变量"""
        env = dict(os.environ)
        env["TOOL_NAME"] = ctx.tool_name
        env["TOOL_WORKDIR"] = ctx.work_dir
        for k, v in ctx.args.items():
            if k in ("workDir", "work_dir"):
                continue
            env_key = "TOOL_ARG_" + k.upper().replace(" ", "_")
            env[env_key] = str(v) if v is not None else ""
        if ctx.result:
            env["TOOL_RESULT"] = ctx.result[:4096]
        return env

    def _exec_hook(self, command: str, ctx: HookContext, timeout: int) -> tuple:
        """执行 shell 命令（跨平台）"""
        env = self._build_env(ctx)
        is_win = platform.system() == "Windows"
        shell = True
        try:
            if is_win:
                result = subprocess.run(
                    command, shell=shell, cwd=ctx.work_dir, timeout=timeout,
                    capture_output=True, text=True, env=env,
                )
            else:
                result = subprocess.run(
                    ["bash", "-c", command], cwd=ctx.work_dir, timeout=timeout,
                    capture_output=True, text=True, env=env,
                )
            return (result.returncode == 0, (result.stdout or "").strip(), (result.stderr or "").strip())
        except Exception as e:
            return (False, "", str(e))

    def run_pre_tool_use(self, ctx: HookContext) -> HookResult:
        """执行 PreToolUse 钩子（合并执行：所有匹配的钩子都触发）"""
        if not self._enabled:
            return HookResult()

        block = False
        message = ""
        appends = []

        for hook in self.hooks["PreToolUse"]:
            if not self._match_pattern(hook.pattern, ctx.tool_name):
                continue
            try:
                import sys as _sys
                _sys.stderr.write(f'  \x1b[90m[Hook] PreToolUse {hook.pattern} → {hook.command[:60]}\x1b[0m\n')
                ok, stdout, stderr = self._exec_hook(hook.command, ctx, hook.timeout)

                if not ok:
                    block = True
                    message = (f'[Hook 拦截] "{hook.pattern}" 阻止了 {ctx.tool_name}'
                               + (f": {stderr}" if stderr else ""))
                    break
                if stdout:
                    appends.append(f"[Hook 提示] {stdout}")
            except Exception as e:
                appends.append(f"[Hook 警告] 钩子执行失败: {e}")

        return HookResult(block=block, message=message, append="\n".join(appends))

    def run_post_tool_use(self, ctx: HookContext) -> HookResult:
        """执行 PostToolUse 钩子（合并执行：所有匹配的钩子都触发）"""
        if not self._enabled:
            return HookResult()

        appends = []

        for hook in self.hooks["PostToolUse"]:
            if not self._match_pattern(hook.pattern, ctx.tool_name):
                continue
            try:
                import sys as _sys
                _sys.stderr.write(f'  \x1b[90m[Hook] PostToolUse {hook.pattern} → {hook.command[:60]}\x1b[0m\n')
                ok, stdout, stderr = self._exec_hook(hook.command, ctx, hook.timeout)

                if stdout:
                    appends.append(f"[Hook 后处理] {stdout}")
                if stderr and not ok:
                    appends.append(f"[Hook 后处理警告] {stderr}")
            except Exception as e:
                appends.append(f"[Hook 后处理警告] 钩子执行失败: {e}")

        return HookResult(append="\n".join(appends))
