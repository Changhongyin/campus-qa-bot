# 量大智答 · 校园问答机器人

面向中国计量大学（CJLU）的校园智能问答机器人。基于 **DeepSeek 大模型 + 本地知识库语义检索（RAG）**，
支持多轮对话、知识库溯源、无关问题拒答，并内置工业化安全防线与测试体系。

## 技术栈
| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite 5 + TypeScript |
| 后端 | Express 4 + TypeScript（tsx 运行） |
| 大模型 | DeepSeek API（deepseek-chat，OpenAI 兼容协议） |
| 语义检索 | @xenova/transformers（all-MiniLM-L6-v2 本地 ONNX，经 hf-mirror）+ TF-IDF 降级 |
| 安全 | helmet + CORS 白名单 + express-rate-limit + 轻量鉴权 + 防提示词注入 |
| 测试 | smoke / edge / final_acceptance 三套脚本（49 项） |

## 目录结构
    .
    ├── server.ts              # 后端入口（Express + 双闸门 + 语义检索 + DeepSeek）
    ├── lib/
    │   ├── retriever.ts       # 语义检索引擎（切块→向量化→Top3→热更新）
    │   ├── gate.ts            # 拒答闸门（别名快判 + 意图分类兜底）
    │   └── prompt.ts          # 系统提示词（含防提示词注入）
    ├── documents/             # ★ 本地知识库（.txt/.md，增删即热更新，免重启）
    ├── src/                   # React 前端（含来源徽标）
    ├── tests/                 # smoke_test / edge_test / final_acceptance
    ├── scripts/               # scan_secrets.py 等工具
    ├── .trae/documents/       # PRD.md / tech-arch.md / dev-plan.md
    ├── tsconfig.json          # 后端类型检查
    └── tsconfig.app.json      # 前端类型检查

## 环境要求
- Node.js ≥ 20（推荐 22+）
- npm
- （可选）Python 3 用于跑测试脚本

## 从零启动步骤
    # 1. 安装依赖
    npm install

    # 2. 配置 API Key（严禁写进代码，写入 .env，已 gitignore）
    cp .env.example .env
    # 编辑 .env：DEEPSEEK_API_KEY=sk-你的Key

    # 3. 构建前端
    npm run build

    # 4. 启动后端（默认端口 3000）
    npm start
    # 开发模式（热重载）：npm run dev

    # 5. 浏览器打开 http://localhost:3000

## 类型检查
    npm run typecheck   # 后端 + 前端双端 tsc --noEmit，零错误

## 测试
先启动服务，然后：
    python3 scripts/scan_secrets.py        # 密钥泄露扫描
    python3 tests/smoke_test.py            # 10 项核心回归
    python3 tests/edge_test.py             # 17 项边缘/对抗
    python3 tests/final_acceptance.py      # 22 项总体验收
    # 可指定服务地址：BASE_URL=http://localhost:3000 python3 tests/smoke_test.py

## 安全设计（四层纵深）
1. **接入层**：限流（默认 120 req/min/IP，可调 RATE_LIMIT_PER_MIN）、CORS 白名单（CORS_ORIGINS）、
   轻量鉴权（设置 API_AUTH_KEY 后要求 X-API-Key 头）。
2. **闸门层**：别名快判 + 大模型意图分类兜底，先闸门后注入，拒答与检索解耦。
3. **提示词层**：防间接提示词注入，知识库内容一律视为数据而非指令。
4. **前端层**：React 默认转义 + 三态来源徽标（知识库命中 / 大模型泛答 / 拒答）。

## 知识库
- 知识库位于 documents/ 目录，支持 .txt / .md，UTF-8 编码。
- 增删改文件后**无需重启**，检索引擎自动热更新（按文件名+mtime+size 指纹判重）。
- 命中知识库时，回答末尾自动附【来源：文件名】溯源标签。

## 提示词修改位置
- 系统提示词：lib/prompt.ts 的 buildSystemPrompt()
- 拒答规则：lib/gate.ts 的 quickGate() 与 classifyIntent()
- 知识库：documents/*.txt

## 文档
- .trae/documents/PRD.md —— 产品需求文档
- .trae/documents/tech-arch.md —— 技术架构文档
- .trae/documents/dev-plan.md —— 里程碑开发计划（M1-M7）
