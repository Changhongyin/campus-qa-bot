import { useEffect, useRef } from 'react';
import { copy } from '../copy';
import type { ChatState } from '../types';
import type { PersonalQaEntry } from '../lib/personalQa';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { PersonalQaPanel } from './PersonalQaPanel';
import { QuickPrompts } from './QuickPrompts';
import { StatusPill } from './StatusPill';

interface ChatShellProps {
  state: ChatState;
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onRegenerate: () => Promise<void>;
  onOpenUpload: () => void;
  onTyping: () => void;
  ttsEnabled: boolean;
  ttsSupported: boolean;
  onToggleTts: () => void;
  personalEntries: PersonalQaEntry[];
  personalOpen: boolean;
  onOpenPersonal: () => void;
  onClosePersonal: () => void;
  onSavePersonal: (entry: Pick<PersonalQaEntry, 'id' | 'question' | 'answer'>) => void;
  onRemovePersonal: (id: string) => void;
  onClear: () => void;
  onExport: () => void;
}

export function ChatShell(props: ChatShellProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <section ref={ref} className="chat-shell" tabIndex={-1} aria-label={copy.app.title}>
      <header className="chat-header">
        <button className="icon-button" type="button" onClick={props.onBack} aria-label={copy.chat.back}>←</button>
        <div className="chat-header__brand"><span className="brand-mark brand-mark--small" aria-hidden="true">量</span><strong>{copy.app.title}</strong><StatusPill mode={props.state.mode} /></div>
        <div className="chat-header__actions">
          {props.ttsSupported ? <button className="text-button" data-testid="tts-toggle" type="button" onClick={props.onToggleTts} aria-label={copy.chat.tts}>{props.ttsEnabled ? copy.chat.ttsOn : copy.chat.ttsOff}</button> : null}
          <button className="text-button" data-testid="upload-open" type="button" onClick={props.onOpenUpload} disabled={!props.state.contributionsEnabled} title={!props.state.contributionsEnabled ? copy.chat.uploadUnavailable : undefined}>{copy.chat.upload}</button>
          <button className="text-button" data-testid="personal-qa-open" type="button" onClick={props.onOpenPersonal}>{copy.chat.personal}</button>
          <button className="text-button" data-testid="export-chat" type="button" onClick={props.onExport}>{copy.chat.export}</button>
          <button className="text-button" data-testid="clear-chat" type="button" onClick={props.onClear}>{copy.chat.clear}</button>
        </div>
      </header>
      <div className="chat-shell__body"><MessageList state={props.state} onRegenerate={props.onRegenerate} onStop={props.onStop} /><QuickPrompts disabled={props.state.isStreaming} onSelect={props.onSend} /></div>
      <Composer disabled={props.state.isStreaming} onSend={props.onSend} onTyping={props.onTyping} />
      <PersonalQaPanel open={props.personalOpen} entries={props.personalEntries} onClose={props.onClosePersonal} onSave={props.onSavePersonal} onRemove={props.onRemovePersonal} />
    </section>
  );
}
