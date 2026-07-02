"""
Cortex Agent Skills 技能系统
══════════════════════════════════════

参考 Claude Code Custom Slash Commands 设计：
  - Skills 存储在 .cortex/skills/*.md
  - 每个 Skill 是一个 Markdown 文件，包含 prompt 模板
  - /skill <name> 加载技能 prompt 到上下文
  - /skills 列出所有可用技能
"""

import os, re, glob as _glob
from typing import List, Dict, Optional


class Skill:
    """一个可复用的技能模块"""
    def __init__(self, name: str, description: str, prompt: str, 
                 category: str = "general", filepath: str = ""):
        self.name = name
        self.description = description
        self.prompt = prompt
        self.category = category
        self.filepath = filepath

    def to_prompt(self, user_input: str = "") -> str:
        """将技能 prompt 注入到系统消息中"""
        base = f"[技能: {self.name}]\n{self.prompt}"
        if user_input:
            base += f"\n\n用户请求: {user_input}"
        return base


class SkillManager:
    """技能管理器 — 加载/列表/调用"""
    
    SKILLS_DIR = ".cortex/skills"

    def __init__(self, project_dir: str = None):
        self.project_dir = project_dir or os.getcwd()
        self.skills: Dict[str, Skill] = {}
        self._builtin_skills()
        self._load_from_disk()

    def _builtin_skills(self):
        """内置默认技能"""
        builtins = {
            "code-review": Skill(
                name="code-review",
                description="代码审查 — 分析代码质量、安全漏洞、性能问题",
                category="development",
                prompt=(
                    "你是一个资深代码审查专家。请对以下代码进行审查，关注：\n"
                    "1. 逻辑错误和边界情况\n"
                    "2. 安全漏洞（注入、越权、泄露）\n"
                    "3. 性能瓶颈\n"
                    "4. 可读性和维护性\n"
                    "5. 是否遵循项目现有代码风格\n\n"
                    "给出具体的修改建议和优先级（高/中/低）。"
                ),
            ),
            "refactor": Skill(
                name="refactor",
                description="代码重构 — 改进结构而不改变行为",
                category="development",
                prompt=(
                    "你是一个代码重构专家。请分析以下代码并提出重构方案：\n"
                    "1. 识别可以提取的函数/类\n"
                    "2. 简化复杂条件逻辑\n"
                    "3. 消除重复代码\n"
                    "4. 改善命名\n"
                    "5. 应用合适的设计模式\n\n"
                    "输出重构前后的对比，并解释每次改动的理由。"
                ),
            ),
            "test-writer": Skill(
                name="test-writer",
                description="测试编写 — 自动生成单元测试",
                category="development",
                prompt=(
                    "你是一个测试工程师。为以下代码编写全面的单元测试：\n"
                    "1. 覆盖正常路径和边界情况\n"
                    "2. 覆盖错误处理和异常路径\n"
                    "3. 使用项目已有的测试框架\n"
                    "4. 每个测试用例包含清晰的描述\n"
                    "5. Mock 外部依赖"
                ),
            ),
            "doc-writer": Skill(
                name="doc-writer",
                description="文档编写 — 生成 API 文档和注释",
                category="documentation",
                prompt=(
                    "你是一个技术文档撰写专家。为以下代码编写文档：\n"
                    "1. 模块/类的用途说明\n"
                    "2. 公共 API 的参数、返回值、异常说明\n"
                    "3. 使用示例\n"
                    "4. 注意事项和限制\n\n"
                    "输出格式使用 Markdown。"
                ),
            ),
            "debug": Skill(
                name="debug",
                description="调试分析 — 错误日志和堆栈跟踪分析",
                category="development",
                prompt=(
                    "你是一个调试专家。请分析以下错误/日志：\n"
                    "1. 定位根本原因\n"
                    "2. 解释错误发生的上下文\n"
                    "3. 提供修复方案（含代码）\n"
                    "4. 建议如何防止同类问题"
                ),
            ),
            "explain": Skill(
                name="explain",
                description="代码解释 — 逐行解释代码逻辑",
                category="learning",
                prompt=(
                    "你是一个编程教师。请逐段解释以下代码：\n"
                    "1. 整体架构和数据流\n"
                    "2. 关键算法和数据结构\n"
                    "3. 重要的设计决策\n"
                    "4. 初学者容易困惑的地方\n\n"
                    "使用通俗易懂的语言，配合图表描述（用 ASCII art）。"
                ),
            ),
            "architect": Skill(
                name="architect",
                description="架构设计 — 系统设计和技术方案",
                category="design",
                prompt=(
                    "你是一个系统架构师。请针对以下需求设计技术方案：\n"
                    "1. 整体架构图（用 ASCII art 描述）\n"
                    "2. 组件/模块划分及职责\n"
                    "3. 数据流和接口设计\n"
                    "4. 技术选型建议及理由\n"
                    "5. 潜在风险和权衡\n\n"
                    "输出结构化的设计文档。"
                ),
            ),
        }
        self.skills.update(builtins)

    def _load_from_disk(self):
        """从 SKILLS_DIR 加载自定义技能（支持相对/绝对路径）。"""
        skills_dir = self.SKILLS_DIR
        if not os.path.isabs(skills_dir):
            skills_dir = os.path.join(self.project_dir, skills_dir)
        if not os.path.isdir(skills_dir):
            return
        for fpath in _glob.glob(os.path.join(skills_dir, "*.md")):
            try:
                skill = self._parse_skill_file(fpath)
                if skill and skill.name not in self.skills:
                    self.skills[skill.name] = skill
            except Exception:
                pass

    def _parse_skill_file(self, fpath: str) -> Optional[Skill]:
        """解析 SKILL.md 格式的技能文件
        
        格式:
          # Skill Name
          > description
          
          [category: xxx]
          
          ---
          prompt content...
        """
        with open(fpath, 'r', encoding='utf-8') as f:
            content = f.read()
        lines = content.split('\n')
        name = os.path.splitext(os.path.basename(fpath))[0]
        description = ""
        category = "custom"
        prompt_start = 0
        for i, line in enumerate(lines):
            if i == 0 and line.startswith('# '):
                name = line[2:].strip()
            elif line.startswith('> '):
                description = line[2:].strip()
            elif line.startswith('[category:'):
                category = line.split(':')[1].rstrip(']').strip()
            elif line.strip() == '---':
                prompt_start = i + 1
                break
        prompt = '\n'.join(lines[prompt_start:]).strip()
        if not prompt:
            prompt = content  # 如果没找到分隔符，整个文件作为 prompt
        return Skill(name=name, description=description, prompt=prompt,
                     category=category, filepath=fpath)

    def list_all(self) -> List[Skill]:
        return list(self.skills.values())

    def list_by_category(self) -> Dict[str, List[Skill]]:
        cats: Dict[str, List[Skill]] = {}
        for s in self.skills.values():
            cats.setdefault(s.category, []).append(s)
        return cats

    def get(self, name: str) -> Optional[Skill]:
        return self.skills.get(name)

    def register(self, skill: Skill):
        self.skills[skill.name] = skill

    def reload(self):
        self.skills = {}
        self._builtin_skills()
        self._load_from_disk()


# 全局单例
_manager: Optional[SkillManager] = None
_last_project_dir: str = ""

def get_skill_manager(project_dir: str = None) -> SkillManager:
    global _manager, _last_project_dir
    pd = project_dir or os.getcwd()
    if _manager is None or pd != _last_project_dir:
        _manager = SkillManager(pd)
        _last_project_dir = pd
    return _manager
