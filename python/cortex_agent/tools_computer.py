"""
Cortex Agent 桌面控制工具 — Computer Use
══════════════════════════════════════════════

computer_screenshot / computer_click
"""

import os, subprocess
from .cortex_agent import registry, RiskLevel, Capability


# ══════════════════════════════════════════════════════════════
# Computer Use (桌面控制)
# ══════════════════════════════════════════════════════════════

@registry.register(
    "截取整个桌面屏幕截图保存到文件。\n"
    "用法: computer_screenshot(path=\"desktop.png\")",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def computer_screenshot(work_dir: str, path: str = "desktop_screenshot.png") -> str:
    d = os.path.realpath(path if os.path.isabs(path) else os.path.join(work_dir, path))
    # workspace 边界检查
    work_real = os.path.realpath(work_dir)
    if not d.startswith(work_real + os.sep) and d != work_real:
        return f"(x) 路径越权: {path} (必须在工作目录内)"
    try:
        import subprocess, base64
        # PowerShell 单引号字符串防止 $() 注入
        ps_script = f'''
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
$bitmap.Save('{d}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output "OK"
'''
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                          capture_output=True, text=True, timeout=15,
                          encoding='utf-8', errors='replace')
        if os.path.isfile(d):
            return f"桌面截图已保存: {path} ({os.path.getsize(d):,} bytes)"
        return f"(x) 截图失败: {r.stderr[:200]}"
    except subprocess.TimeoutExpired:
        return "(x) 截图超时 (>15s)"
    except Exception as e:
        return f"(x) 桌面截图错误: {e}"


@registry.register(
    "模拟鼠标点击桌面坐标。\n"
    "用法: computer_click(x=100, y=200)",
    risk=RiskLevel.SYSTEM, capability=Capability.SHELL)
def computer_click(work_dir: str, x: str = "0", y: str = "0") -> str:
    try:
        xi, yi = int(x), int(y)
        import subprocess
        # 用 PowerShell SendKeys / mouse_event
        ps_script = f'''
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseOps {{
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
    public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const int MOUSEEVENTF_LEFTUP = 0x0004;
}}
"@
[MouseOps]::SetCursorPos({xi}, {yi})
[MouseOps]::mouse_event([MouseOps]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100
[MouseOps]::mouse_event([MouseOps]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
Write-Output "已点击 ({xi}, {yi})"
'''
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script],
                          capture_output=True, text=True, timeout=10,
                          encoding='utf-8', errors='replace')
        out = ((r.stdout or "") + (r.stderr or "")).strip()
        return out or f"已点击 ({xi}, {yi})"
    except Exception as e:
        return f"(x) 点击失败: {e}"


# ══════════════════════════════════════════════════════════════
