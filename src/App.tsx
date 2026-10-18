import { useCallback, useEffect, useMemo, useState } from 'react';
import { copy } from './copy';
import { ChatShell } from './components/ChatShell';
import { LandingPage } from './components/LandingPage';
import { UploadPanel } from './components/UploadPanel';
import { useChatStream } from './hooks/useChatStream';
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis';
import { exportConversation } from './lib/export';
import { listPersonalQa, matchPersonalQa, removePersonalQa, savePersonalQa, type PersonalQaEntry } from './lib/personalQa';
import { getHealth } from './lib/api';
import './styles.css';

export default function App() {
  const chat = useChatStream();
  const speech = useSpeechSynthesis();
  const [personalOpen, setPersonalOpen] = useState(false);
  const [personalEntries, setPersonalEntries] = useState<PersonalQaEntry[]>(() => listPersonalQa());
  const [includePersonal, setIncludePersonal] = useState(false);

  useEffect(() => {
    document.title = chat.state.view === 'chat' ? copy.app.activeTitle : copy.app.title;
  }, [chat.state.view]);

  useEffect(() => {
    void getHealth().then((health) => chat.setHealth(health.mode, health.contributions.enabled)).catch(() => chat.setHealth('unknown', false));
  }, []);

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
    const exported = exportConversation(chat.state.messages, includePersonal, personalEntries);
    if (!exported) window.alert(copy.chat.exportEmpty);
    else window.alert(copy.chat.exportReady);
  }, [chat.state.messages, includePersonal, personalEntries]);

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
      onToggleTts={() => speech.setEnabled(!speech.enabled)}
      personalEntries={personalEntries}
      personalOpen={personalOpen}
      onOpenPersonal={() => setPersonalOpen(true)}
      onClosePersonal={() => setPersonalOpen(false)}
      onSavePersonal={handleSavePersonal}
      onRemovePersonal={handleRemovePersonal}
      onClear={handleClear}
      onExport={handleExport}
    />
  ), [chat, handleSend, speech, personalEntries, personalOpen, handleSavePersonal, handleRemovePersonal, handleClear, handleExport]);

  return (
    <main className={`app app--${chat.state.view}`}>
      <LandingPage
        onOpenChat={() => { chat.openChat(); sessionStorage.setItem('ldzd-opened', 'true'); }}
        onOpenUpload={() => chat.setUploadOpen(true)}
        contributionsEnabled={chat.state.contributionsEnabled}
      />
      <div className="chat-transition">{chatShell}</div>
      <UploadPanel open={chat.state.uploadOpen} onClose={() => chat.setUploadOpen(false)} />
      <label className="sr-only">
        <input type="checkbox" checked={includePersonal} onChange={(event) => setIncludePersonal(event.target.checked)} />
        {copy.chat.exportPersonal}
      </label>
    </main>
  );
}
