#!/usr/bin/env node
const { execSync } = require('child_process');

console.log('\n📦 Cortex Agent — npm postinstall');
console.log('   正在检查 Python 依赖...\n');

// 检测可用的 Python 包管理器
function detectPython() {
    const managers = [
        { name: 'uv', cmd: 'uv tool install cortex-agent', check: 'uv --version' },
        { name: 'pipx', cmd: 'pipx install cortex-agent', check: 'pipx --version' },
        { name: 'pip', cmd: 'pip install cortex-agent', check: 'pip --version' },
    ];

    for (const mgr of managers) {
        try {
            execSync(mgr.check, { stdio: 'pipe' });
            return mgr;
        } catch (_) {}
    }
    return null;
}

const mgr = detectPython();

if (mgr) {
    console.log(`   ✓ 检测到 ${mgr.name}`);
    try {
        // 尝试安装（如果已安装则跳过）
        execSync(`${mgr.cmd} --quiet 2>/dev/null || ${mgr.cmd}`, {
            stdio: 'inherit',
            env: { ...process.env, PIP_REQUIRE_VIRTUALENV: 'false' }
        });
        console.log(`   ✓ Python 包安装完成`);
    } catch (e) {
        console.log(`   ⚠ 跳过安装 (可能已存在或需要手动安装)`);
        console.log(`   → 手动安装: ${mgr.cmd}`);
    }
} else {
    console.log('   ⚠ 未检测到 Python 包管理器');
    console.log('   → 请先安装 Python，然后: pip install cortex-agent');
}

console.log('\n   🚀 安装完成！运行: cortex-agent\n');

// 从 npm 全局包目录读取本地的 main.py
const path = require('path');
const fs = require('fs');
const localMain = path.join(__dirname, '..', 'main.py');

if (fs.existsSync(localMain)) {
    console.log('   💡 检测到本地源码，pip install -e . 或直接运行 python main.py\n');
}
