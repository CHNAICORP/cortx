#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 查找 Python 入口
// 优先级: pip 安装的 cortex-agent 命令 > 本地 main.py
function findEntry() {
    // 1. 尝试全局 pip 安装的 cortex-agent 命令
    const globalPaths = process.env.PATH.split(path.delimiter);
    for (const dir of globalPaths) {
        const candidate = path.join(dir, 'cortex-agent');
        const candidateWin = path.join(dir, 'cortex-agent.exe');
        if (fs.existsSync(candidate) || fs.existsSync(candidateWin)) {
            return { type: 'command', path: 'cortex-agent' };
        }
    }
    // 2. 回退到 pipx/uv 安装
    try {
        const pipxDir = path.join(process.env.HOME || process.env.USERPROFILE, '.local', 'bin');
        const pipxCandidate = path.join(pipxDir, 'cortex-agent');
        if (fs.existsSync(pipxCandidate)) {
            return { type: 'command', path: pipxCandidate };
        }
    } catch (_) {}

    // 3. 本地开发: python -m main
    const localMain = path.join(__dirname, '..', 'main.py');
    if (fs.existsSync(localMain)) {
        return { type: 'module', path: localMain };
    }

    // 4. 回退: python -m cortex_agent 或 python main.py
    return { type: 'fallback', path: null };
}

const entry = findEntry();
const args = process.argv.slice(2);

let child;
switch (entry.type) {
    case 'command':
        child = spawn(entry.path, args, { stdio: 'inherit', shell: true });
        break;
    case 'module':
        child = spawn('python', [entry.path, ...args], { stdio: 'inherit' });
        break;
    default:
        // 尝试 python -m cortex_agent，然后 python main.py
        child = spawn('python', ['-c',
            'import sys; sys.argv[1:] = ' + JSON.stringify(args) + '; ' +
            'try:\n' +
            '  from main import main; main()\n' +
            'except ImportError:\n' +
            '  print("Error: cortex-agent not found. Run: pip install cortex-agent")\n' +
            '  sys.exit(1)'
        ], { stdio: 'inherit' });
}

if (child) {
    child.on('exit', (code) => process.exit(code || 0));
}
