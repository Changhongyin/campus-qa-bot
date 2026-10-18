# CampusQA Backend API v2

Base URL: `http://localhost:3000` (Express). All bodies are JSON, UTF-8. Every `/api/*` response may carry
`X-Request-Id` (chat always does). When `API_AUTH_KEY` is set, every `/api/*` call must send the header
`X-API-Key: <value>`; otherwise the server answers `401 {"error": "..."}`.

User-facing strings (`error`, `message`, thought texts, refusal text) are Simplified Chinese (zh-CN).
Codes and field names are stable English identifiers.

## 1. GET /api/health

```json
{
  "ok": true,
  "model": "deepseek-chat",
  "apiKeyConfigured": true,
  "authEnabled": false,
  "rateLimitPerMin": 120,
  "retriever": { "chunks": 10, "engine": "tfidf", "ready": true },
  "mode": "deepseek",
  "contributions": { "enabled": true, "mode": "pr", "maxBytes": 204800 },
  "version": "2.0.0"
}
mode is "deepseek" when DEEPSEEK_API_KEY is set, otherwise "offline". contributions.enabled is false when the channel cannot accept uploads (GitHub not configured in pr or direct mode, or local mode on a read-only runtime). Hide the upload UI in that case.

2. GET /api/knowledge
json


{
  "datastore": "local-text-files",
  "note": "...",
  "files": [{ "name": "CJLU.txt", "chars": 4210, "lines": 96 }],
  "retriever": { "chunks": 10, "engine": "tfidf", "ready": true },
  "contributions": { "files": 0 }
}
files lists the .txt and .md files directly inside documents/. contributions.files counts merged contribution files under documents/contributions/ that are indexed. File contents are never returned.

3. POST /api/chat
Request:

json


{
  "messages": [{ "role": "user", "content": "string" }],
  "stream": false,
  "sessionId": "optional, max 64 chars"
}
Validation: 1 to 10 messages, each content 1 to 2000 characters after trim, the last message must have role user, total content at most 12000 characters, unknown fields ignored. Messages with another role or a non-string content are dropped. Invalid input returns 400 {"error": "...", "code": "BAD_REQUEST"}. Regenerate is client driven: truncate your own history and send again.

3.1 JSON response (default)
json


{
  "reply": "string",
  "badge": "knowledge",
  "sources": ["CJLU.txt"],
  "engine": "tfidf",
  "mode": "deepseek",
  "requestId": "req_0a23db76c1d545189c5e",
  "latencyMs": 1814,
  "usage": { "prompt_tokens": 849, "completion_tokens": 34 }
}
reply, badge (knowledge | general | refusal), sources, engine (embedding | tfidf | none) are mandatory. mode, requestId, latencyMs are additive; usage appears only when the model reports it. When retrieval hits, reply ends with \n\n【来源：<files joined by 、>】.

Errors: 502 UPSTREAM_ERROR, 504 TIMEOUT, 500 INTERNAL, each as {"error","code","requestId"}. The chat limiter (default 120 per minute per IP) answers 429 {"error": "..."} without a code.

3.2 Streaming response ("stream": true)
Status 200 with headers Content-Type: text/event-stream; charset=utf-8, Cache-Control: no-cache, no-transform, Connection: keep-alive, X-Accel-Buffering: no. Frames are event: <name>\ndata: <json>\n\n.

代码块


event: meta
data: {"requestId":"req_...","mode":"deepseek","model":"deepseek-chat","ts":1730000000000}

event: thought
data: {"stage":"intent","text":"已识别为校园相关问题","ms":3}

event: thought
data: {"stage":"retrieve","text":"找到 3 段相关资料：CJLU.txt（相似度 0.42）","ms":18,
        "detail":{"hits":3,"sources":["CJLU.txt"],"topScore":0.42},
        "snippets":[{"source":"CJLU.txt","title":"校训","text":"...","score":0.42}]}

event: thought
data: {"stage":"rank","text":"已按相关度排序资料","ms":0}

event: thought
data: {"stage":"compose","text":"开始组织回答","ms":0}

event: token
data: {"text":"partial answer"}

event: done
data: {"reply":"full answer","badge":"knowledge","sources":["CJLU.txt"],"engine":"tfidf",
       "latencyMs":2871,"requestId":"req_...","usage":{"prompt_tokens":0,"completion_tokens":0},
       "snippets":[...]}

event: error
data: {"code":"UPSTREAM_ERROR","message":"..."}
Invariants:

meta is always the first event.
Thought stages come in the order intent, retrieve, rank, compose. A refusal has only intent and compose. For an unclear question the single intent event says the rule check is done and classification is running; there is no second intent event.
thought.text is at most 48 characters, has no emoji, and reports only facts of this request.
The concatenation of all token.text equals done.reply. This includes the trailing source line, which is sent as the final token. Empty tokens are never sent.
Exactly one terminal event, done or error, and nothing after it.
A comment line : hb is sent every 15000 ms (SSE_HEARTBEAT_MS) while the stream is open.
If the client disconnects, the server aborts the upstream model call and stops timers. No terminal event is sent.
Errors after the headers use codes UPSTREAM_ERROR, TIMEOUT, INTERNAL. Errors before the headers are ordinary JSON with a 4xx or 5xx status.
snippets (top level of the retrieve thought and of done) is optional: [{source, title, text, score}] with text a verbatim passage of at most 160 characters. It is omitted on refusal and when retrieval did not reach the hit threshold. It never changes reply, badge, sources or engine.
In offline mode (mode: "offline") the whole reply arrives as one token.

4. POST /api/upload
Request:

json


{
  "fileName": "campus-notes.txt",
  "content": "UTF-8 text of the file",
  "consent": true,
  "contributor": "optional, up to 40 chars",
  "note": "optional, up to 200 chars"
}
Validation, first failure wins:

Order	Rule	Failure
1	consent === true	422 CONSENT_REQUIRED
2	fileName is a string, at most 80 chars, no /, \, .. or control characters	400 INVALID_FILE_NAME
3	extension is .txt or .md (case-insensitive)	415 UNSUPPORTED_FILE_TYPE
4	content is a string (else 400 INVALID_PAYLOAD), at most CONTRIBUTION_MAX_BYTES bytes (default 204800) and 5000 lines	413 FILE_TOO_LARGE
5	no NUL or C0 control characters except \n, \t (and \r, normalized later); U+FFFD ratio at most 1 percent	422 CONTENT_REJECTED
6	contributor and note become single lines and are truncated silently	none
7	contributions enabled	503 GITHUB_NOT_CONFIGURED
8	content hash not seen in the last 500 submissions, not in a stored contribution	409 DUPLICATE_CONTRIBUTION
9	per-IP rate: UPLOAD_RATE_HOUR per hour and UPLOAD_RATE_DAY per day (default 3 and 10)	429 UPLOAD_RATE_LIMITED plus Retry-After
Only requests that pass steps 1 to 8 consume rate-limit quota. A body above 1 MB is answered by the JSON parser with 413 PAYLOAD_TOO_LARGE; malformed JSON gives 400 BAD_REQUEST.

Success 200:

json


{
  "ok": true,
  "status": "pending_review",
  "submissionId": "c_20261018T012345Z_ab12cd34",
  "sha256": "<64 hex>",
  "storedPath": "documents/contributions/2026/10/c_20261018T012345Z_ab12cd34.txt",
  "branch": "contributions/c_20261018T012345Z_ab12cd34",
  "commitSha": "<40 hex>",
  "pullRequestUrl": "https://github.com/<owner>/<repo>/pull/<n>",
  "message": "..."
}
status is pending_review (mode pr), committed (mode direct, branch is the base branch, no pullRequestUrl) or local_only (mode local; storedPath is documents/inbox/<id>.<ext>, no branch, commitSha or pullRequestUrl).

The submission id has the form c_<UTC timestamp YYYYMMDDTHHMMSSZ>_<8 hex characters>; the Z is uppercase.

Errors use {"ok": false, "code": "...", "error": "..."}.

Stored file (fully server generated, documents/ never contains a user-controlled path segment):

代码块


# contributed: 2026-10-18T01:23:45.678Z
# submission: c_20261018T012345Z_ab12cd34
# sha256: <hex of the normalized content>
# original-name: <sanitized file name>
# contributor: <sanitized>
# note: <sanitized>
# source: user-contribution (unreviewed until merged)

<content: BOM removed, CRLF converted to LF, trailing whitespace trimmed>
Moderation flow
pr mode (default): the server creates the branch contributions/<id> from the base branch, commits the file, and opens a pull request whose body lists id, hash, size, sanitized contributor and note, automated flags (instruction_override, secret_request, role_switch; heuristics that never block) and a review checklist.
A maintainer reviews and merges. Only merged files under documents/contributions/ are indexed by the retriever.
documents/inbox/ (local mode) is git-ignored and never indexed.

5. POST /api/feedback
Request: {"requestId": "optional", "rating": "up" | "down", "reason": "optional, 200", "comment": "optional, 500"}. requestId is used only when it matches [A-Za-z0-9_-]{1,64}. All text is reduced to one line.

up: an in-process counter, logged at most once per minute. Response {"ok": true, "recorded": true}.
down: counted, and when GitHub is configured a GitHub Issue titled feedback: <requestId or generated id> is opened with rating, reason, comment and timestamp (never the question text). Response {"ok": true, "recorded": true, "issueUrl": "..."}.
GitHub not configured, or any GitHub failure: 200 {"ok": true, "recorded": false}. Never a 5xx.
Errors: 400 INVALID_PAYLOAD, 429 RATE_LIMITED (same limits as upload, separate counter, Retry-After set).

6. Error codes
Code	HTTP	Where
BAD_REQUEST	400	chat validation, malformed JSON
INVALID_PAYLOAD	400	upload and feedback body
INVALID_FILE_NAME	400	upload
CONSENT_REQUIRED	422	upload
CONTENT_REJECTED	422	upload
UNSUPPORTED_FILE_TYPE	415	upload
FILE_TOO_LARGE	413	upload
PAYLOAD_TOO_LARGE	413	request body above 1 MB
DUPLICATE_CONTRIBUTION	409	upload
UPLOAD_RATE_LIMITED	429	upload
RATE_LIMITED	429	feedback; also SSE error event name reserved by the contract
GITHUB_NOT_CONFIGURED	503	upload
GITHUB_AUTH_FAILED	502	upload
GITHUB_UPSTREAM_ERROR	502	upload
UPSTREAM_ERROR	502, SSE event	chat
TIMEOUT	504, SSE event	chat
INTERNAL	500, SSE event	all
FEATURE_REQUIRES_NODE_RUNTIME	501	reserved; not returned by any endpoint in this version

7. Environment variables
Variable	Default	Meaning
DEEPSEEK_API_KEY	empty	Model key. Empty means offline mode. Never commit it.
DEEPSEEK_MODEL	deepseek-chat	Model name
DEEPSEEK_API_URL	
https://api.deepseek.com/chat/completions
Chat completions URL
DEEPSEEK_TIMEOUT_MS	45000	Upstream timeout (1000 to 300000)
PORT	3000	HTTP port
RATE_LIMIT_PER_MIN	120	Chat limiter, per IP
CORS_ORIGINS	http://localhost:3000,http://localhost:5173	Allowed browser origins
API_AUTH_KEY	empty	When set, X-API-Key is required on /api/*
SSE_HEARTBEAT_MS	15000	Heartbeat interval
RETRIEVER_MODE	auto (tfidf on Vercel)	tfidf never loads the embedding model
GITHUB_TOKEN	empty	Fine-grained personal access token, server side only. Never commit it.
GITHUB_OWNER	Changhongyin	Repository owner
GITHUB_REPO	campus-qa-bot	Repository name
GITHUB_API_BASE	
https://api.github.com
API base URL
GITHUB_BASE_BRANCH	main	Base branch for pull requests and direct commits
CONTRIBUTION_MODE	pr	pr, direct or local
CONTRIBUTION_MAX_BYTES	204800	Max upload size (1024 to 524288)
UPLOAD_RATE_HOUR	3	Uploads per hour per IP, also used for feedback
UPLOAD_RATE_DAY	10	Uploads per day per IP, also used for feedback
Token permissions (single repository only): Contents read and write, Pull requests read and write, and Issues read and write if feedback issues are wanted. Without the Issues permission, feedback still works and returns recorded: false. Enable branch protection on the base branch as a second line of defense.

8. Deployment matrix
Capability	Express (Node)	Vercel serverless
GET /api/health, GET /api/knowledge	yes	yes, reads the bundled documents/
POST /api/chat JSON	yes	yes
POST /api/chat with stream: true	SSE	degrades to the JSON response (Content-Type: application/json); the frontend falls back automatically
Retrieval engine	embedding, TF-IDF fallback	TF-IDF forced (RETRIEVER_MODE=tfidf, default on Vercel)
POST /api/upload, mode pr or direct	yes	yes
POST /api/upload, mode local	yes	no (read-only file system); upload returns 503 GITHUB_NOT_CONFIGURED
POST /api/feedback	yes	yes
Rate limiters and duplicate hashes	one process, shared	per function instance, best effort
Knowledge hot reload	yes	no, redeploy after merging contributions
Verify a Vercel deployment
Run these against a preview URL and keep the output as evidence:

curl.exe -sS https://<preview>/api/health shows version 2.0.0 and retriever.engine tfidf.
A JSON chat call returns reply, badge, sources, engine.
A chat call with "stream": true returns Content-Type: application/json, not text/event-stream.
An upload with a valid body returns pending_review and a pullRequestUrl; check the PR on GitHub.
In the Vercel function logs there is no module resolution error and no line containing a token.

9. PowerShell examples
Use curl.exe (not the curl alias). Pipe the JSON through stdin and write non-ASCII characters as \uXXXX escapes, because Windows PowerShell re-encodes piped text.

代码块


curl.exe -sS http://localhost:3000/api/health
curl.exe -sS http://localhost:3000/api/knowledge
'{"messages":[{"role":"user","content":"\u4e2d\u56fd\u8ba1\u91cf\u5927\u5b66\u7684\u6821\u8bad\u662f\u4ec0\u4e48"}]}' | curl.exe -sS -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" --data-binary "@-"
'{"messages":[{"role":"user","content":"\u4e2d\u56fd\u8ba1\u91cf\u5927\u5b66\u7684\u6821\u8bad\u662f\u4ec0\u4e48"}],"stream":true}' | curl.exe -N -sS -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" --data-binary "@-"
'{"rating":"up"}' | curl.exe -sS -X POST http://localhost:3000/api/feedback -H "Content-Type: application/json" --data-binary "@-"
Add -H "X-API-Key: <your key>" when API_AUTH_KEY is set.

10. Worked upload example
代码块


'{"fileName":"library-hours.txt","content":"Library opening hours: weekdays 08:00 to 22:00.","consent":true,"contributor":"Alex","note":"from the front desk sign"}' | curl.exe -sS -X POST http://localhost:3000/api/upload -H "Content-Type: application/json" --data-binary "@-"
Response in pr mode:

json


{
  "ok": true,
  "status": "pending_review",
  "submissionId": "c_20261018T012345Z_ab12cd34",
  "sha256": "<64 hex>",
  "storedPath": "documents/contributions/2026/10/c_20261018T012345Z_ab12cd34.txt",
  "branch": "contributions/c_20261018T012345Z_ab12cd34",
  "commitSha": "<40 hex>",
  "pullRequestUrl": "https://github.com/Changhongyin/campus-qa-bot/pull/12",
  "message": "感谢你的贡献！内容已提交审核，管理员合并后就会进入知识库～"
}
Sending the same content again returns 409 DUPLICATE_CONTRIBUTION and does not consume quota.

11. Known limitations
The duplicate check covers the last 500 submissions of the running process and every contribution file present on disk at startup. A duplicate that sits in an open, unmerged pull request from before a restart is not detected.
On a failed pull-request flow the already created branch is not deleted; a maintainer can remove it.
Rate limits use req.ip. Behind a reverse proxy that does not forward the client address, all users share one bucket.
