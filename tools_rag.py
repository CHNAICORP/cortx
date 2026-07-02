"""
Cortex Agent RAG 工具 — 知识检索
══════════════════════════════════════

search_knowledge: FTS5 全文搜索项目文件（BM25 相关性排序）
rebuild_knowledge_index: 重建索引
"""

import os, sqlite3, re as _re
from cortex_agent import registry, RiskLevel, Capability

_fts5_indexed = False


def _build_fts5_index(work_dir: str):
    """构建项目文件的 FTS5 全文索引（首次调用时自动创建）。"""
    global _fts5_indexed
    db_path = os.path.join(work_dir, "agent.db")
    db = sqlite3.connect(db_path)
    db.execute(
        "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts "
        "USING fts5(path, content, tokenize='unicode61')"
    )
    if not _fts5_indexed:
        project_root = os.path.dirname(os.path.abspath(work_dir))
        for root_dir, dirs, files in os.walk(project_root):
            # 阻止进入隐藏目录和 workspace（修改 dirs 原地生效）
            dirs[:] = [d for d in dirs
                       if not d.startswith('.')
                       and d not in ('__pycache__', 'cortex_workspace', 'node_modules', '.git')]
            for fn in files:
                if fn.endswith(('.md', '.py', '.txt', '.json')) and not fn.startswith('.'):
                    fpath = os.path.join(root_dir, fn)
                    try:
                        with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                            content = f.read()[:5000]
                        rel = os.path.relpath(fpath, project_root)
                        db.execute(
                            "INSERT OR REPLACE INTO knowledge_fts(rowid, path, content) "
                            "VALUES(?,?,?)",
                            (hash(rel) & 0x7FFFFFFF, rel, content)
                        )
                    except Exception:
                        pass
        db.commit()
        _fts5_indexed = True
    db.close()


@registry.register(
    "全文搜索项目知识库（FTS5+BM25 相关性排序）。搜索所有 .md/.py/.txt/.json 文件。\n"
    "用法: search_knowledge(query=\"agentic loop\")",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def search_knowledge(work_dir: str, query: str) -> str:
    if not query or not query.strip():
        return "(x) 请提供搜索关键词"
    try:
        _build_fts5_index(work_dir)
        db_path = os.path.join(work_dir, "agent.db")
        db = sqlite3.connect(db_path)
        # FTS5 full-text search with BM25 ranking
        try:
            rows = db.execute(
                "SELECT path, snippet(knowledge_fts, 1, '<b>', '</b>', '...', 40) as snippet, "
                "rank FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT 10",
                (query,)
            ).fetchall()
        except sqlite3.OperationalError:
            # FTS5 syntax error → fallback to LIKE
            rows = db.execute(
                "SELECT path, substr(content, 1, 200) as snippet, 0 as rank "
                "FROM knowledge_fts WHERE content LIKE ? LIMIT 10",
                (f"%{query}%",)
            ).fetchall()
        db.close()

        if not rows:
            # Fallback: real-time grep across project files
            project_root = os.path.dirname(os.path.abspath(work_dir))
            results = []
            try:
                pattern = _re.compile(_re.escape(query), _re.I)
            except Exception:
                pattern = _re.compile(query, _re.I)
            for root_dir, _, files in os.walk(project_root):
                if '/.' in root_dir or '\\.' in root_dir or 'cortex_workspace' in root_dir:
                    continue
                for fn in files:
                    if fn.endswith(('.md', '.py', '.txt')):
                        fpath = os.path.join(root_dir, fn)
                        try:
                            with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                                for lineno, line in enumerate(f, 1):
                                    if pattern.search(line) and len(results) < 10:
                                        results.append(
                                            (os.path.relpath(fpath, project_root),
                                             f"L{lineno}: {line.strip()[:100]}")
                                        )
                        except Exception:
                            pass
                if len(results) >= 10:
                    break
            if not results:
                return f"(未找到与 '{query}' 相关的内容)"
            lines_out = [f"搜索 '{query}' ({len(results)} 条):\n"]
            for path, snippet in results:
                lines_out.append(f"  {chr(0x1F4C4)} {path}")
                lines_out.append(f"     {snippet}")
            return "\n".join(lines_out)

        lines_out = [f"搜索 '{query}' ({len(rows)} 条, FTS5 相关性排序):\n"]
        for path, snippet, rank in rows:
            lines_out.append(f"  {chr(0x1F4C4)} {path} (rank={rank})")
            lines_out.append(f"     {snippet}")
        return "\n".join(lines_out)
    except Exception as e:
        return f"(x) 搜索失败: {e}"


@registry.register(
    "重建知识库全文索引。项目文件变更后使用。",
    risk=RiskLevel.SAFE, capability=Capability.FS_READ)
def rebuild_knowledge_index(work_dir: str) -> str:
    global _fts5_indexed
    db_path = os.path.join(work_dir, "agent.db")
    db = sqlite3.connect(db_path)
    db.execute("DROP TABLE IF EXISTS knowledge_fts")
    db.commit()
    db.close()
    _fts5_indexed = False
    _build_fts5_index(work_dir)
    return "知识库索引已重建"
