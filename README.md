# 量大智答 · 校园问答机器人

面向中国计量大学（CJLU）的校园智能问答机器人。基于 **DeepSeek 大模型 + 本地知识库语义检索（RAG）**，
支持多轮对话、流式输出、知识库溯源、无关问题拒答、用户贡献知识库，并内置工业化安全防线与测试体系。

## 技术栈
| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite 5 + TypeScript |
| 后端 | Express 4 + TypeScript（tsx 运行），SSE 流式输出 |
| 大模型 | DeepSeek API（deepseek-chat，OpenAI 兼容协议） |
| 语义检索 | @xenova/transformers（all-MiniLM-L6-v2 本地 ONNX，经 hf-mirror）+ TF-IDF 降级 |
| 贡献通道 | GitHub REST API（拉取请求审核，无新增依赖） |
| 安全 | helmet + CORS 白名单 + express-rate-limit + 轻量鉴权 + 防提示词注入 |
| 测试 | smoke / edge / final_acceptance 三套脚本（49 项）+ v2 新增脚本 |

## Architecture v2

```text
Browser (React)
  |  POST /api/chat (stream:true -> SSE)   POST /api/upload   POST /api/feedback
  |  GET /api/health   GET /api/knowledge
  v
Express (server.ts): helmet -> CORS allowlist -> optional X-API-Key -> rate limits -> lib/handlers/*

chat      quickGate -> classifyIntent -> refusal
          retriever (embedding or TF-IDF) -> snippets -> DeepSeek stream -> tokens -> done
upload    validation -> duplicate check -> upload limiter -> GitHub pull request (or direct / local inbox)
feedback  validation -> limiter -> counter (+ GitHub Issue on "down")
```
Endpoint	Purpose
POST /api/chat	JSON reply, or SSE with meta, staged thought, token, done when stream: true
POST /api/upload	Contribute a .txt or .md file; opens a pull request for review
POST /api/feedback	Thumbs up or down; "down" can open a GitHub Issue
GET /api/health	Status, mode, contribution settings, version
GET /api/knowledge	Knowledge files, retriever stats, merged contribution count
The full contract, error codes and a deployment matrix are in docs/API.md.

目录结构
代码块


.
├── server.ts              # 后端入口：中间件与路由装配
├── start.cmd              # Windows 一键启动
├── lib/
│   ├── config.ts          # 环境变量（密钥不可枚举）
│   ├── retriever.ts       # 语义检索引擎（递归扫描 documents/，热更新）
│   ├── gate.ts            # 拒答闸门（别名快判 + 意图分类兜底）
│   ├── prompt.ts          # 系统提示词（人设 + 防提示词注入）
│   ├── deepseek.ts        # DeepSeek 客户端（流式/非流式）
│   ├── sse.ts, thoughts.ts, snippets.ts, redact.ts, limiter.ts
│   ├── github.ts, upload.ts
│   └── handlers/          # chat, upload, feedback, health, knowledge
├── documents/             # ★ 本地知识库（.txt/.md，增删即热更新）
│   ├── contributions/     # 已合并的用户贡献（合并后才会被检索）
│   └── inbox/             # 本地模式暂存（已 gitignore，不会被检索）
├── docs/API.md            # 接口契约
├── src/                   # React 前端
├── tests/                 # smoke_test / edge_test / final_acceptance 及 v2 测试
├── scripts/               # scan_secrets.py 等工具
├── tsconfig.json          # 后端类型检查
└── tsconfig.app.json      # 前端类型检查
环境要求
Node.js ≥ 20（推荐 22+）
npm
（可选）Python 3 用于跑测试脚本（Windows 使用 py -3）
从零启动步骤
Windows 可直接双击或运行 start.cmd（检查 Node、按需安装依赖、构建、启动，并在约 8 秒后打开浏览器）。手动步骤：

代码块


# 1. 安装依赖
npm install

# 2. 配置（严禁把密钥写进代码，写入 .env，已 gitignore）
cp .env.example .env
# 编辑 .env：DEEPSEEK_API_KEY=你的Key

# 3. 构建前端
npm run build

# 4. 启动后端（默认端口 3000）
npm start
# 开发模式（热重载）：npm run dev

# 5. 浏览器打开 http://localhost:3000
Environment variables
Copy .env.example to .env. Main groups (full table in docs/API.md):

Group	Variables
Model	DEEPSEEK_API_KEY, DEEPSEEK_MODEL, DEEPSEEK_TIMEOUT_MS
Server	PORT, RATE_LIMIT_PER_MIN, CORS_ORIGINS, API_AUTH_KEY, SSE_HEARTBEAT_MS, RETRIEVER_MODE
Contributions	GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_API_BASE, GITHUB_BASE_BRANCH, CONTRIBUTION_MODE, CONTRIBUTION_MAX_BYTES, UPLOAD_RATE_HOUR, UPLOAD_RATE_DAY
GITHUB_TOKEN is a fine-grained personal access token limited to this repository (Contents and Pull requests read/write, plus Issues read/write for feedback issues). It lives only in .env and is never returned or logged.

Contribution moderation flow
A user submits a text file to POST /api/upload with explicit consent.
The server validates it, rejects duplicates, and (mode pr, the default) creates the branch contributions/<id>, commits documents/contributions/<yyyy>/<mm>/<id>.txt, and opens a pull request. The PR lists hash, size, contributor, note, automated warning flags and a review checklist.
A maintainer reviews and merges. Nothing is indexed before the merge.
After the merge, the file under documents/contributions/ becomes searchable (hot reload on Express, redeploy on Vercel).
Other modes: direct commits straight to the base branch (not recommended), local writes to the git-ignored documents/inbox/ for development.

类型检查
代码块


npm run typecheck   # 后端 + 前端双端 tsc --noEmit，零错误
Verification commands
先启动服务，然后：

代码块


py -3 scripts/scan_secrets.py          # 密钥泄露扫描
py -3 tests/smoke_test.py              # 10 项核心回归
py -3 tests/edge_test.py               # 17 项边缘/对抗
py -3 tests/final_acceptance.py        # 22 项总体验收
# 指定服务地址（PowerShell）：$env:BASE_URL='http://localhost:3000'
Streaming demo (PowerShell, see docs/API.md for more):

代码块


'{"messages":[{"role":"user","content":"\u4e2d\u56fd\u8ba1\u91cf\u5927\u5b66\u7684\u6821\u8bad\u662f\u4ec0\u4e48"}],"stream":true}' | curl.exe -N -sS -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" --data-binary "@-"
Deployment options
Windows, one click: start.cmd.
Any Node 20+ host: npm install, npm run build, npm start, with the variables above set in the host environment.
Vercel: JSON chat, upload (pr or direct), feedback and health work; streaming degrades to JSON and the retriever is forced to TF-IDF. See the deployment matrix and the verification steps in docs/API.md.
安全设计（四层纵深）
接入层：限流（默认 120 req/min/IP，可调 RATE_LIMIT_PER_MIN）、CORS 白名单（CORS_ORIGINS）、 轻量鉴权（设置 API_AUTH_KEY 后要求 X-API-Key 头）；上传与反馈各有独立的小时/日限额。
闸门层：别名快判 + 大模型意图分类兜底，先闸门后注入，拒答与检索解耦。
提示词层：防间接提示词注入，知识库内容一律视为数据而非指令；模型不会复述用户消息中的可疑文本。
前端层：React 默认转义 + 三态来源徽标（知识库命中 / 大模型泛答 / 拒答）。
贡献内容一律视为不受信任数据：服务端生成全部路径、不执行、不渲染、合并前不进入检索。

知识库
知识库位于 documents/ 目录，支持 .txt / .md，UTF-8 编码，子目录会被递归扫描（_ 开头目录和 inbox 除外）。
增删改文件后无需重启，检索引擎自动热更新（按文件名+mtime+size 指纹判重）。
命中知识库时，回答末尾自动附【来源：文件名】溯源标签。
提示词修改位置
系统提示词：lib/prompt.ts 的 buildSystemPrompt()
拒答规则：lib/gate.ts 的 quickGate() 与 classifyIntent()
知识库：documents/*.txt
文档
docs/API.md —— 后端接口契约 v2
.trae/documents/PRD.md —— 产品需求文档
.trae/documents/tech-arch.md —— 技术架构文档
.trae/documents/dev-plan.md —— 里程碑开发计划（M1-M7）

## Easter Egg Integration

A hidden film behind the landing page's masthead seal. Only `.landing__masthead .brand-mark`
opens it. The chat-header seal, the message avatars and the empty-state seal are not triggers.

**Sequence.** Click 1 shakes the seal (±4px, 120ms). Click 2 shakes it harder (±10px, ±3deg,
200ms) and mounts the media, hidden, so the film and the anthem start preloading. Click 3 makes the
page recede (`scale(.92)`, `blur(8px)`, fade, 600ms, with landing text characters leaving in
sequence). Then the film and the anthem start together. Clicks more than 1.5s apart start the count
again. `Esc` or **Close** leaves the egg and restores the landing page.

**Clock.** The `<audio>` element is the master clock. The muted `<video>` plays at
`playbackRate = 1` and is checked every animation frame: only when it is more than 0.5 s off the
anthem (after a stall or a seek) is it put back with one seek, never while a seek is in flight.
Smaller drift is left alone; nudging the rate every frame made the picture judder. When the
film ends, the video holds its last frame and the final dynamic stage takes over: a survey grid
drifting at `60s linear infinite`, a glow breathing at `8s ease-in-out infinite`, and the fine
graduations of the film's ring turning slowly.

### Assets

| File | Spec |
|---|---|
| `public/media/anthem.mp3` | The supplied 校歌 recording, stream copied without re-encoding (only metadata stripped and a Xing header added for exact duration), 128 kb/s, 44.1 kHz stereo, **172.70 s** |
| `public/media/easteregg.webm` | VP9, 1920x1080, 30 fps, 5181 frames, **172.70 s**, no audio track, no text of any kind |
| `public/media/easteregg.mp4` | H.264 fallback, same picture and duration, no audio track |
| `public/media/easteregg-final.jpg` | The film's last frame, used as the final stage's base layer if the video cannot be decoded |

**The film.** A campus anime short in the visual language of Makoto Shinkai's films, painted entirely
in code. The places are the protagonist; one university student moves through them, mostly small
against the vista, with close-ups of her profile, her eye, her steps and her hands. Everything is graded
teal in the shadows and orange in the highlights, with bloom and lens flares.

| Time (s) | Shot |
|---|---|
| 0–8.5 | Dawn, the empty classroom: blank blackboard, rows of desks, god rays through the windows, dust |
| 8.5–14.5 | The corridor: light pools on the polished floor; she walks away into the bright end |
| 14.5–21 | Her profile against the window sky; a blink; whiteout |
| 21–31 | Vista: the river at golden hour, the sun bursting through cumulus, power lines; she is a speck on the embankment |
| 31–36.5 | Close: her steps on the embankment path, long shadow, grass, petals |
| 36.5–41.5 | The stairwell: a tall window, a shaft of light across the steps |
| 41.5–49 | Cherry-blossom avenue between the teaching buildings, petals in the wind; she reaches up |
| 49–55 | 细量: her hands steady a spirit level; the bubble comes to rest between the marks |
| 55–58.5 | 细量: a vernier slides into agreement |
| 58.5–61.5 | 细量: her eye at the eyepiece, the scale reflected in the iris |
| 61.5–72 | The level crossing at sunset: signals, the train passes, and she is there on the far side |
| 72–81.6 | 力量: a rooftop under a towering cumulonimbus, sun rays fanning out; she lifts a hand |
| 81.6–92 | Above a sea of clouds at sunset, a tiny figure on a peak |
| 92–102 | Rain on the street at dusk: a convenience store glows, the lights stretch across wet asphalt; she waits under her umbrella and crosses on green |
| 102–112.5 | 精思国计: from the hill, the river winds through the city to the horizon as its lights come on |
| 112.5–125 | A stone stairway up to a pavilion, lanterns and fireflies, the first stars |
| 125–141 | 精思国计: night over the city, the streets resolving into a survey grid, the Milky Way; the star chart in her hands turns until it agrees with the sky |
| 141–158.1 | The star trails tighten into the graduated circle |
| 158.1–172.7 | 计量: the needle locks on 计, the ring opens on 量, dawn rises behind her on the hill; a calm centre for the CSS stage |

It is rendered by `scripts/easteregg/render_film.py` (numpy + pillow + skia-python + ffmpeg) straight
from the anthem. Its sections are cut on times measured in the recording (`CUES` in the script), and
the anthem's loudness drives the light. Re-render with:

```bash
python scripts/easteregg/render_film.py --audio public/media/anthem.mp3 --out-dir public/media
```

### Timing: `D` and `REVEAL_AT_SECONDS`

- **`D` = 172.70 s** (audio 172.6955 s, video 5181 frames at 30 fps = 172.700 s).
- The anthem's last line is "…我的名字叫**计量**". Measured with speech recognition and the loudness
  envelope: **计 from 158.10 s**, a breath, **量 from 162.05 s**, held, then released by **169.25 s**.
  The recording ends with 3.4 s of silence.
- The brief's default, `D - 4` = 168.70 s, would fall in the reverb tail after "量" has been sung.
  So, as the brief allows, the window follows the measured span: **`REVEAL_AT_SECONDS = 158.1`**.
  The film's closing movement is cut to the same marks: the needle sweeps on 计 and locks at
  162.05 s, the ring opens across the frame on 量, and the needle clears the centre by about 166 s.
- `src/easteregg/easteregg-cues.ts` also exports `CHARACTER_CUES_SECONDS` (`ji: 158.1`,
  `liang: 162.05`), `SUNG_END_SECONDS` (169.25) and `FILM_DURATION_SECONDS` (172.7).

### Handoff for the font engineer

- **Reveal container.** `<div className="egg-final-reveal" data-state="awaiting" />` sits centred in
  `.egg-stage`, which becomes the final dynamic stage. It is mounted when playback starts, not when
  the film ends, because the reveal cue (158.1 s) comes before `D`. It is empty; inject the characters.
  Suggested markup: `<p class="egg-reveal-line"><span data-char>计</span><span data-char>量</span></p>`
  and `<p class="egg-reveal-line" data-motto>…</p>`. Lines stack, character spans never wrap, and
  sizes come from the on-screen picture height (`--egg-frame-h`), not from a typeface:
  `--egg-display-size` and `--egg-motto-size`.
- **Clock.** `useVideoClock()` (in `src/easteregg/EggClock.tsx`) returns
  `{ currentTime, duration, video }`, refreshed every animation frame. `useEggMedia()` gives the raw
  `videoRef` and `audioRef`. Cue on `video.currentTime`, never on timers.
- **Dev overlay.** In `vite` dev builds, the bottom-left corner shows
  `video.currentTime / video.duration`, the audio time and drift, and whether the reveal cue has passed.
- **Font slots.** Defined on `:root` in `src/styles/easteregg.css`, with Latin fallbacks only and no
  web fonts: `--egg-font-display` (计量), `--egg-font-motto` (motto), `--egg-font-ui` (buttons and
  small UI text). Nothing in the egg sets `font-family` any other way.
- **Check.** `BASE_URL=http://localhost:5173 node tests/easteregg_e2e.mjs` runs the whole sequence in
  Chromium and writes screenshots to `screenshots/easteregg-*.png`.
