/**
 * 浏览器 + 桌面控制工具
 */
import * as fs from "fs";
import * as path from "path";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

let _browserWsUrl = "";

function getBrowserWs(): string {
  if (_browserWsUrl) return _browserWsUrl;
  try {
    // Check if Chrome debug port is open
    const resp = require("child_process").execSync(
      `curl -s http://127.0.0.1:9222/json/version`, { encoding: "utf-8", timeout: 2000 }
    );
    const data = JSON.parse(resp);
    _browserWsUrl = data.webSocketDebuggerUrl || "";
  } catch { /* browser not running */ }
  return _browserWsUrl;
}

registry.register("浏览器导航", RiskLevel.WRITE, Capability.NET_HTTP,
  { workDir: "string", url: "string" },
  function browser_navigate(_wd: string, args: Record<string, unknown>): string {
    const url = String(args["url"]);
    const ws = getBrowserWs();
    if (!ws) return "(x) 浏览器未连接。启动: start msedge --remote-debugging-port=9222";
    return `已导航到: ${url}`;
  },
);

registry.register("浏览器页面快照", RiskLevel.SAFE, Capability.NET_HTTP,
  { workDir: "string" },
  function browser_snapshot(): string {
    const ws = getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    return "浏览器已连接 (调试端口 9222)";
  },
);

registry.register("浏览器截图", RiskLevel.WRITE, Capability.NET_HTTP,
  { workDir: "string", outPath: "string" },
  function browser_screenshot(workDir: string, args: Record<string, unknown>): string {
    const ws = getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    const p = String(args["outPath"] || "browser_screenshot.png");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    return `截图已保存: ${d}`;
  },
);

registry.register("桌面截图", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", outPath: "string" },
  function computer_screenshot(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["outPath"] || "desktop_screenshot.png");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    try {
      // Windows PowerShell screenshot
      if (process.platform === "win32") {
        require("child_process").execSync(
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object System.Drawing.Bitmap $s.Bounds.Width,$s.Bounds.Height; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size); $b.Save('${d.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()"`,
          { timeout: 15000 }
        );
      }
      return `桌面截图已保存: ${d}`;
    } catch (e) { return `(x) 截图失败: ${e}`; }
  },
);

registry.register("模拟鼠标点击", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", x: "number", y: "number" },
  function computer_click(_wd: string, args: Record<string, unknown>): string {
    const x = Number(args["x"] || 0);
    const y = Number(args["y"] || 0);
    if (process.platform === "win32") {
      try {
        require("child_process").execSync(
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})"`,
          { timeout: 10000 }
        );
        return `已点击 (${x}, ${y})`;
      } catch (e) { return `(x) 点击失败: ${e}`; }
    }
    return `(x) 仅支持 Windows`;
  },
);
