"""测试脚本: 通过 Agent 注册的工具函数测试 Office 文档操作"""
import sys, os, subprocess, json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

# Refresh PATH (officecli installed to user PATH)
r = subprocess.run(
    ["powershell", "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')"],
    capture_output=True, text=True
)
os.environ["PATH"] = r.stdout.strip() + os.pathsep + os.environ.get("PATH", "")

# Import only the office tools module (avoids importing tools_rag which needs _sqlite3)
from cortex_agent.cortex_agent import registry
from cortex_agent import tools_office  # noqa: triggers office tool registration

WORK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(WORK_DIR, exist_ok=True)

def call_tool(name, **kwargs):
    """调用已注册的工具函数"""
    fn = registry.get(name)
    if not fn:
        print(f"  (x) 工具 {name} 未找到!")
        return None
    return fn(WORK_DIR, **kwargs)

# ═══════════════════════════════════════════════════════════════
# 📊 测试 1: Excel — 创建销售报表
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("📊 测试 1: Excel — 创建销售报表")
print("=" * 60)

# 1) 创建文件
print("\n[1] office_create(filename='sales_report.xlsx')")
r = call_tool("office_create", filename="sales_report.xlsx", force=True)
print(f"    {r}")

# 2) 批量写入数据
print("\n[2] office_batch — 写入表头+5行数据+汇总公式+列宽")
batch_cmds = [
    # 表头
    {"command": "set", "path": "/Sheet1/A1", "props": {"text": "Region", "bold": "true"}},
    {"command": "set", "path": "/Sheet1/B1", "props": {"text": "Units", "bold": "true"}},
    {"command": "set", "path": "/Sheet1/C1", "props": {"text": "Price", "bold": "true"}},
    {"command": "set", "path": "/Sheet1/D1", "props": {"text": "Revenue", "bold": "true"}},
    # 数据行
    {"command": "set", "path": "/Sheet1/A2", "props": {"text": "North"}},
    {"command": "set", "path": "/Sheet1/B2", "props": {"text": "120"}},
    {"command": "set", "path": "/Sheet1/C2", "props": {"text": "9.5"}},
    {"command": "set", "path": "/Sheet1/D2", "props": {"formula": "B2*C2"}},
    {"command": "set", "path": "/Sheet1/A3", "props": {"text": "South"}},
    {"command": "set", "path": "/Sheet1/B3", "props": {"text": "95"}},
    {"command": "set", "path": "/Sheet1/C3", "props": {"text": "11.0"}},
    {"command": "set", "path": "/Sheet1/D3", "props": {"formula": "B3*C3"}},
    {"command": "set", "path": "/Sheet1/A4", "props": {"text": "East"}},
    {"command": "set", "path": "/Sheet1/B4", "props": {"text": "140"}},
    {"command": "set", "path": "/Sheet1/C4", "props": {"text": "8.75"}},
    {"command": "set", "path": "/Sheet1/D4", "props": {"formula": "B4*C4"}},
    {"command": "set", "path": "/Sheet1/A5", "props": {"text": "West"}},
    {"command": "set", "path": "/Sheet1/B5", "props": {"text": "60"}},
    {"command": "set", "path": "/Sheet1/C5", "props": {"text": "12.5"}},
    {"command": "set", "path": "/Sheet1/D5", "props": {"formula": "B5*C5"}},
    {"command": "set", "path": "/Sheet1/A6", "props": {"text": "Central"}},
    {"command": "set", "path": "/Sheet1/B6", "props": {"text": "110"}},
    {"command": "set", "path": "/Sheet1/C6", "props": {"text": "10.0"}},
    {"command": "set", "path": "/Sheet1/D6", "props": {"formula": "B6*C6"}},
    # 汇总行
    {"command": "set", "path": "/Sheet1/A7", "props": {"text": "TOTAL", "bold": "true"}},
    {"command": "set", "path": "/Sheet1/B7", "props": {"formula": "SUM(B2:B6)"}},
    {"command": "set", "path": "/Sheet1/D7", "props": {"formula": "SUM(D2:D6)", "bold": "true"}},
    # 列宽
    {"command": "set", "path": "/Sheet1/col[A]", "props": {"width": "15"}},
    {"command": "set", "path": "/Sheet1/col[B]", "props": {"width": "10"}},
    {"command": "set", "path": "/Sheet1/col[C]", "props": {"width": "10"}},
    {"command": "set", "path": "/Sheet1/col[D]", "props": {"width": "12"}},
]
r = call_tool("office_batch", filename="sales_report.xlsx", commands_json=json.dumps(batch_cmds))
print(f"    {r}")

# 3) 读取验证
print("\n[3] office_send — 读取 A1 单元格验证")
r = call_tool("office_send", filename="sales_report.xlsx", command="get", path="/Sheet1/A1")
print(f"    {r}")

# 4) 查看大纲
print("\n[4] office_view — 查看文档大纲")
r = call_tool("office_view", filename="sales_report.xlsx", mode="outline")
print(f"    {r[:400]}")

# 5) 验证文档
print("\n[5] office_send — validate")
r = call_tool("office_send", filename="sales_report.xlsx", command="validate")
print(f"    {r}")

# 6) 保存
print("\n[6] office_send — save")
r = call_tool("office_send", filename="sales_report.xlsx", command="save")
print(f"    {r}")

fpath = os.path.join(WORK_DIR, "sales_report.xlsx")
fsize = os.path.getsize(fpath) if os.path.exists(fpath) else 0
print(f"\n✅ Excel 完成: {fpath} ({fsize:,} bytes)")


# ═══════════════════════════════════════════════════════════════
# 📝 测试 2: Word — 创建季度报告
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("📝 测试 2: Word — 创建季度报告")
print("=" * 60)

# 1) 创建文件
print("\n[1] office_create(filename='quarterly_review.docx')")
r = call_tool("office_create", filename="quarterly_review.docx", force=True)
print(f"    {r}")

# 2) 写入标题
print("\n[2] office_send — 添加主标题 (Heading1)")
r = call_tool("office_send", filename="quarterly_review.docx",
              command="add", parent="/body", element_type="paragraph",
              props=json.dumps({"text": "Q4 2026 Quarterly Review", "style": "Heading1",
                                "size": "20pt", "bold": "true", "spaceAfter": "12pt"}))
print(f"    {r[:200]}")

# 3) 写入摘要段落
print("\n[3] office_send — 添加摘要段落")
r = call_tool("office_send", filename="quarterly_review.docx",
              command="add", parent="/body", element_type="paragraph",
              props=json.dumps({"text": "Revenue grew 18% year-over-year, ahead of plan. Enterprise renewals and a new EMEA region drove the upside.", "size": "11pt", "spaceAfter": "8pt"}))
print(f"    {r[:200]}")

# 4) 写入二级标题和列表
print("\n[4] office_batch — 批量添加: 二级标题 + 列表项 + 二级标题 + 段落")
batch2 = [
    {"command": "add", "parent": "/body", "type": "paragraph",
     "props": {"text": "Key Drivers", "style": "Heading2", "size": "14pt", "bold": "true", "spaceBefore": "12pt", "spaceAfter": "6pt"}},
    {"command": "add", "parent": "/body", "type": "paragraph",
     "props": {"text": "Enterprise renewals up 22%", "size": "11pt", "spaceAfter": "4pt"}},
    {"command": "add", "parent": "/body", "type": "paragraph",
     "props": {"text": "New EMEA region launched in October", "size": "11pt", "spaceAfter": "4pt"}},
    {"command": "add", "parent": "/body", "type": "paragraph",
     "props": {"text": "Upsell rate improved to 34%", "size": "11pt", "spaceAfter": "4pt"}},
    {"command": "add", "parent": "/body", "type": "paragraph",
     "props": {"text": "Challenges", "style": "Heading2", "size": "14pt", "bold": "true", "spaceBefore": "12pt", "spaceAfter": "6pt"}},
    {"command": "add", "parent": "/body", "type": "paragraph",
     "props": {"text": "Churn in the SMB segment ticked up to 4.2%, driven by price sensitivity in the contractor tier. Mitigation plan in progress.", "size": "11pt"}},
]
r = call_tool("office_batch", filename="quarterly_review.docx", commands_json=json.dumps(batch2))
print(f"    {r}")

# 5) 添加页脚页码
print("\n[5] office_send — 添加页脚 (含页码字段)")
r = call_tool("office_send", filename="quarterly_review.docx",
              command="add", parent="/", element_type="footer",
              props=json.dumps({"type": "default", "size": "9pt", "text": "Page ", "field": "page"}))
print(f"    {r[:200]}")

r = call_tool("office_send", filename="quarterly_review.docx",
              command="set", path="/footer[1]/p[1]",
              props=json.dumps({"align": "center"}))
print(f"    {r[:200]}")

# 6) 验证
print("\n[6] office_send — validate")
r = call_tool("office_send", filename="quarterly_review.docx", command="validate")
print(f"    {r}")

# 7) 查看大纲
print("\n[7] office_view — 查看文档大纲")
r = call_tool("office_view", filename="quarterly_review.docx", mode="outline")
print(f"    {r[:500]}")

# 8) 保存
print("\n[8] office_send — save")
r = call_tool("office_send", filename="quarterly_review.docx", command="save")
print(f"    {r}")

fpath = os.path.join(WORK_DIR, "quarterly_review.docx")
fsize = os.path.getsize(fpath) if os.path.exists(fpath) else 0
print(f"\n✅ Word 完成: {fpath} ({fsize:,} bytes)")


# ═══════════════════════════════════════════════════════════════
# 🎯 测试 3: PowerPoint — 创建产品演示文稿
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("🎯 测试 3: PowerPoint — 创建产品演示文稿")
print("=" * 60)

# 1) 创建文件
print("\n[1] office_create(filename='product_pitch.pptx')")
r = call_tool("office_create", filename="product_pitch.pptx", force=True)
print(f"    {r}")

# 2) 添加第一张幻灯片（标题页）
print("\n[2] office_send — 添加 slide 1 (标题页)")
r = call_tool("office_send", filename="product_pitch.pptx",
              command="add", parent="/", element_type="slide")
print(f"    {r[:200]}")

# 标题
r = call_tool("office_send", filename="product_pitch.pptx",
              command="add", parent="/slide[1]", element_type="shape",
              props=json.dumps({"type": "textBox", "x": "2cm", "y": "3cm", "width": "28cm", "height": "3cm",
                                "text": "Product Launch 2026", "fontSize": "36pt", "bold": "true",
                                "align": "center", "font": "Georgia"}))
print(f"    标题: {r[:150]}")

# 副标题
r = call_tool("office_send", filename="product_pitch.pptx",
              command="add", parent="/slide[1]", element_type="shape",
              props=json.dumps({"type": "textBox", "x": "4cm", "y": "7cm", "width": "24cm", "height": "2cm",
                                "text": "Next-Generation AI Platform", "fontSize": "20pt",
                                "align": "center", "font": "Calibri"}))
print(f"    副标题: {r[:150]}")

# 备注
r = call_tool("office_send", filename="product_pitch.pptx",
              command="add", parent="/slide[1]", element_type="notes",
              props=json.dumps({"text": "Welcome the audience. Briefly introduce the product vision."}))
print(f"    备注: {r[:150]}")

# 3) 添加第二张幻灯片（市场机会）
print("\n[3] office_batch — 添加 slide 2 (市场机会: 标题+两个数据卡片)")
batch3 = [
    {"command": "add", "parent": "/", "type": "slide"},
    {"command": "add", "parent": "/slide[2]", "type": "shape",
     "props": {"type": "textBox", "x": "2cm", "y": "1cm", "width": "28cm", "height": "2cm",
               "text": "Market Opportunity", "fontSize": "32pt", "bold": "true", "font": "Georgia"}},
    {"command": "add", "parent": "/slide[2]", "type": "shape",
     "props": {"type": "textBox", "x": "2cm", "y": "4cm", "width": "12cm", "height": "5cm",
               "text": "$45B TAM\nGrowing 22% annually\n3.2M target users",
               "fontSize": "18pt", "font": "Calibri"}},
    {"command": "add", "parent": "/slide[2]", "type": "shape",
     "props": {"type": "textBox", "x": "16cm", "y": "4cm", "width": "12cm", "height": "5cm",
               "text": "68% enterprise adoption\n12% migration rate\n4x ROI in Year 1",
               "fontSize": "18pt", "font": "Calibri"}},
    {"command": "add", "parent": "/slide[2]", "type": "notes",
     "props": {"text": "Emphasize the $45B total addressable market and 22% growth rate."}},
]
r = call_tool("office_batch", filename="product_pitch.pptx", commands_json=json.dumps(batch3))
print(f"    {r}")

# 4) 添加第三张幻灯片（产品特性）
print("\n[4] office_batch — 添加 slide 3 (产品特性)")
batch4 = [
    {"command": "add", "parent": "/", "type": "slide"},
    {"command": "add", "parent": "/slide[3]", "type": "shape",
     "props": {"type": "textBox", "x": "2cm", "y": "1cm", "width": "28cm", "height": "2cm",
               "text": "Key Features", "fontSize": "32pt", "bold": "true", "font": "Georgia"}},
    {"command": "add", "parent": "/slide[3]", "type": "shape",
     "props": {"type": "textBox", "x": "3cm", "y": "4cm", "width": "26cm", "height": "8cm",
               "text": "Real-time AI inference at edge\nMulti-modal understanding (text, image, voice)\nZero-config deployment pipeline\nEnterprise-grade security & compliance",
               "fontSize": "20pt", "font": "Calibri"}},
    {"command": "add", "parent": "/slide[3]", "type": "notes",
     "props": {"text": "Walk through each feature. Spend 30 seconds on multi-modal capabilities."}},
]
r = call_tool("office_batch", filename="product_pitch.pptx", commands_json=json.dumps(batch4))
print(f"    {r}")

# 5) 验证
print("\n[5] office_send — validate")
r = call_tool("office_send", filename="product_pitch.pptx", command="validate")
print(f"    {r}")

# 6) 查看大纲
print("\n[6] office_view — 查看文档大纲")
r = call_tool("office_view", filename="product_pitch.pptx", mode="outline")
print(f"    {r[:600]}")

# 7) 保存
print("\n[7] office_send — save")
r = call_tool("office_send", filename="product_pitch.pptx", command="save")
print(f"    {r}")

fpath = os.path.join(WORK_DIR, "product_pitch.pptx")
fsize = os.path.getsize(fpath) if os.path.exists(fpath) else 0
print(f"\n✅ PowerPoint 完成: {fpath} ({fsize:,} bytes)")


# ═══════════════════════════════════════════════════════════════
# 📋 总结
# ═══════════════════════════════════════════════════════════════
print("\n" + "=" * 60)
print("📋 测试总结")
print("=" * 60)
for name, f in [("Excel", "sales_report.xlsx"), ("Word", "quarterly_review.docx"), ("PowerPoint", "product_pitch.pptx")]:
    fp = os.path.join(WORK_DIR, f)
    if os.path.exists(fp):
        print(f"  ✅ {name:12s} {f:30s} {os.path.getsize(fp):>8,} bytes")
    else:
        print(f"  ❌ {name:12s} {f:30s} 未生成")

print("\n测试工具: office_create, office_send, office_batch, office_view")
print("通信方式: 命名管道 (officecli resident)")
