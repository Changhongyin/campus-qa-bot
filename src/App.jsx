import React, { useEffect, useRef, useState } from 'react';

const QUICK = [
  '我们学校的特色专业是什么？',
  '中国计量大学的校训是什么？',
  '学校有几个校区？在哪里？',
  '今天杭州天气怎么样？',
];

/* 轻量 Markdown 渲染：转义 HTML 后仅支持 **加粗**（其余按纯文本换行显示） */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderContent(text) {
  const safe = escapeHtml(text || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return { __html: safe };
}

export default function App() {
  const [messages, setMessages] = useState([
    {
      role: 'assistant',
      content:
        '你好呀！我是中国计量大学校园问答机器人"量量" 🎓\n我掌握本校的本地知识库，可以回答校训、历史、特色专业、校区等问题；与校园无关的问题我会礼貌拒绝哦～',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d) => setMode(d.mode))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send(text) {
    const q = (text ?? input).trim();
    if (!q || loading) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setLoading(true);
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await resp.json();
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: data.reply || ('出错了：' + (data.error || '未知错误')) },
      ]);
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: '网络错误：' + e.message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="logo">量</div>
        <div>
          <h1>中国计量大学 · 校园问答机器人</h1>
          <p className="sub">
            本地知识库 + DeepSeek 大模型 ｜ 校训：精思国计，细量民生
            {mode && <span className="badge">{mode === 'deepseek' ? 'DeepSeek 在线' : '离线知识库模式'}</span>}
          </p>
        </div>
      </header>

      <main className="chat" data-testid="chat-window">
        {messages.map((m, i) => (
          <div key={i} className={'bubble ' + m.role} data-testid={'msg-' + m.role}>
            <div className="avatar">{m.role === 'user' ? '我' : '量'}</div>
            <div className="text" dangerouslySetInnerHTML={renderContent(m.content)} />
          </div>
        ))}
        {loading && (
          <div className="bubble assistant">
            <div className="avatar">量</div>
            <div className="text typing">正在思考…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <div className="quick">
        {QUICK.map((q) => (
          <button key={q} onClick={() => send(q)} disabled={loading}>
            {q}
          </button>
        ))}
      </div>

      <footer className="composer">
        <input
          value={input}
          placeholder="请输入与中国计量大学校园相关的问题…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          data-testid="chat-input"
        />
        <button onClick={() => send()} disabled={loading || !input.trim()} data-testid="send-btn">
          发送
        </button>
      </footer>
    </div>
  );
}
