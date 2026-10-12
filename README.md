# 中国计量大学 · 校园问答机器人（campus-qa-bot）

基于 **Node.js + Express + React + DeepSeek API** 的校园问答智能体实验作品。
机器人角色："量量"，只回答与中国计量大学校园相关的问题，无关问题自动拒答。

## 一、目录结构
```
campus-qa-bot/
├── server.js                 # Express 后端：/api/chat，注入提示词+知识库，调用 DeepSeek
├── documents/CJLU.txt        # ★ 本地知识库（新增 txt 会自动被载入）
├── src/App.jsx               # React 聊天界面
├── src/main.jsx, styles.css  # 前端入口与样式
├── index.html, vite.config.js
├── tests/screenshot_bot.py   # Playwright 自动化测试 + 截图脚本
├── scripts/generate_report.py# python-docx 生成实验报告
├── screenshots/              # 自动生成的截图（A 验证知识库 / B 验证拒答）
├── templates/report_template.docx  # 由"实验报告格式.doc"转换而来的报告模板
└── .env.example              # 环境变量示例（DEEPSEEK_API_KEY）
```

## 二、提示词修改位置（作业要求：AI 写代码，自己写提示词）
- **系统提示词**：`server.js` → `buildSystemPrompt()` 函数内部（文件开头有 ★ 注释指引）。
  角色设定、拒答规则、语气要求都在这个函数的中文数组里，直接修改即可。
- **知识库**：`documents/*.txt`，重启服务后自动生效。

## 三、运行方法
```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key（严禁写进代码，使用环境变量）
cp .env.example .env
# 编辑 .env：DEEPSEEK_API_KEY=sk-你的Key
# 或者临时：export DEEPSEEK_API_KEY=sk-你的Key

# 3. 构建前端并启动后端
npm run build
node server.js
# 浏览器打开 http://localhost:3000
```

> 未配置 `DEEPSEEK_API_KEY` 时，服务会自动进入 **离线知识库模式**：
> 用本地检索回答校园问题、拒绝无关问题，保证演示与截图可复现；
> 配置 Key 后自动切换为 DeepSeek 在线模式，界面右上角徽标会显示当前模式。

## 四、自动化测试与截图
```bash
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/screenshot_bot.py
```
输出：`screenshots/screenshot_A_knowledge.png`、`screenshots/screenshot_B_refusal.png`、`screenshots/answers.json`

## 五、安全说明
API Key 只从环境变量 `DEEPSEEK_API_KEY` 读取，代码中不含任何密钥；`.env` 已被 `.gitignore` 忽略。
