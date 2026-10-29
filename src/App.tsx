import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copy } from './copy';
import { ChatShell } from './components/ChatShell';
import { FieldBackdrop } from './components/FieldBackdrop';
import { LandingPage } from './components/LandingPage';
import { UploadPanel } from './components/UploadPanel';
import { useChatStream } from './hooks/useChatStream';
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis';
import { exportConversation } from './lib/export';
import { listPersonalQa, matchPersonalQa, removePersonalQa, savePersonalQa, type PersonalQaEntry } from './lib/personalQa';
import { getHealth } from './lib/api';
import { EasterEgg } from './easteregg/EasterEgg';
import { useEasterEgg } from './easteregg/useEasterEgg';
import './styles.css';

export default function App() {
  const chat = useChatStream();
  const speech = useSpeechSynthesis();
  const lastSpokenRef = useRef<string | null>(null);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [personalEntries, setPersonalEntries] = useState<PersonalQaEntry[]>(() => listPersonalQa());
  const egg = useEasterEgg();

  useEffect(() => {
    document.title = chat.state.view === 'chat' ? copy.app.activeTitle : copy.app.title;
  }, [chat.state.view]);

  useEffect(() => {
    void getHealth().then((health) => chat.setHealth(health.mode, health.contributions.enabled)).catch(() => chat.setHealth('unknown', false));
  }, []);

  // 朗读：每当出现一条新的机器人回答（且朗读开关开启）就自动读出来。
  useEffect(() => {
    if (!speech.enabled) return;
    const last = [...chat.state.messages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
    if (!last || last.id === lastSpokenRef.current) return;
    lastSpokenRef.current = last.id;
    speech.speak(last.content);
  }, [chat.state.messages, speech.enabled, speech.speak]);

  const handleToggleTts = useCallback((): void => {
    const next = !speech.enabled;
    speech.setEnabled(next);
    if (!next) {
      lastSpokenRef.current = null;
      return;
    }
    // 开启时立刻朗读最近一条回答（在用户手势内触发，浏览器才允许发声）。
    const last = [...chat.state.messages].reverse().find((message) => message.role === 'assistant' && message.content.trim());
    if (last) {
      lastSpokenRef.current = last.id;
      speech.speak(last.content);
    }
  }, [speech, chat.state.messages]);

  const handleSend = useCallback(async (text: string): Promise<void> => {
    speech.cancel();
    const match = matchPersonalQa(text);
    if (match) {
      chat.sendPersonalAnswer(text.trim(), match.answer);
      return;
    }
    await chat.send(text);
  }, [chat, speech]);

  const handleSavePersonal = useCallback((entry: Pick<PersonalQaEntry, 'id' | 'question' | 'answer'>): void => {
    setPersonalEntries(savePersonalQa(entry));
  }, []);

  const handleRemovePersonal = useCallback((id: string): void => {
    setPersonalEntries(removePersonalQa(id));
  }, []);

  const handleExport = useCallback((): void => {
    const withPersonal = personalEntries.length > 0
      ? window.confirm('导出对话时是否包含个人问答？\n\n确定 = 包含，取消 = 不包含')
      : false;
    const exported = exportConversation(chat.state.messages, withPersonal, personalEntries);
    if (!exported) window.alert(copy.chat.exportEmpty);
    else window.alert(copy.chat.exportReady);
  }, [chat.state.messages, personalEntries]);

  const handleClear = useCallback((): void => {
    if (window.confirm(copy.chat.clearConfirm)) chat.clearMessages();
  }, [chat]);

  const chatShell = useMemo(() => (
    <ChatShell
      state={chat.state}
      onBack={() => chat.setView('landing')}
      onSend={handleSend}
      onStop={chat.stop}
      onRegenerate={chat.regenerate}
      onOpenUpload={() => chat.setUploadOpen(true)}
      onTyping={speech.cancel}
      ttsEnabled={speech.enabled}
      ttsSupported={speech.supported}
      onToggleTts={handleToggleTts}
      personalEntries={personalEntries}
      personalOpen={personalOpen}
      onOpenPersonal={() => setPersonalOpen(true)}
      onClosePersonal={() => setPersonalOpen(false)}
      onSavePersonal={handleSavePersonal}
      onRemovePersonal={handleRemovePersonal}
      onClear={handleClear}
      onExport={handleExport}
    />
  ), [chat, handleSend, handleToggleTts, speech, personalEntries, personalOpen, handleSavePersonal, handleRemovePersonal, handleClear, handleExport]);

  return (
    <main
      className={chat.state.view === 'chat' ? 'app app--chat' : 'app app--landing'}
      data-egg={egg.stage === 'idle' || egg.stage === 'armed' ? undefined : egg.stage}
      onAnimationEnd={egg.onPageAnimationEnd}
    >
      <FieldBackdrop />
      <LandingPage
        active={chat.state.view === 'landing'}
        seal={{ buttonRef: egg.sealRef, shake: egg.shake, onClick: egg.onSealClick, onAnimationEnd: egg.onSealAnimationEnd }}
        onOpenChat={() => { chat.openChat(); sessionStorage.setItem('ldzd-opened', 'true'); }}
        onOpenUpload={() => chat.setUploadOpen(true)}
        contributionsEnabled={chat.state.contributionsEnabled}
      />
      <div className="chat-transition">{chatShell}</div>
      <UploadPanel open={chat.state.uploadOpen} onClose={() => chat.setUploadOpen(false)} />
      {egg.stage === 'placeholder' ? <EasterEgg onClose={egg.close} /> : null}
    </main>
  );
}
