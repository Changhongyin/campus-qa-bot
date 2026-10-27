import { FormEvent, KeyboardEvent, useRef, useState } from 'react';
import { copy } from '../copy';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useSpeechInput } from '../hooks/useSpeechInput';

interface ComposerProps { disabled: boolean; onSend: (text: string) => Promise<void>; onTyping: () => void; }

export function Composer({ disabled, onSend, onTyping }: ComposerProps) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeechInput((text) => setValue(text));
  // Narrow screens get the short hint; the visually hidden label keeps the full text.
  const compact = useMediaQuery('(max-width: 480px)');
  const submit = async (): Promise<void> => { if (!value.trim() || disabled) return; const text = value.trim(); setValue(''); await onSend(text); ref.current?.focus(); };
  return <form className="composer" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(); }}>
    <label className="sr-only" htmlFor="chat-input">{copy.chat.inputPlaceholder}</label>
    <textarea ref={ref} id="chat-input" data-testid="chat-input" value={value} rows={1} maxLength={2000} disabled={disabled} placeholder={compact ? copy.chat.inputPlaceholderShort : copy.chat.inputPlaceholder} onChange={(event) => { setValue(event.target.value); onTyping(); }} onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
    {speech.supported ? <button data-testid="mic-toggle" className="icon-button" type="button" disabled={disabled} onClick={speech.toggle} aria-label={copy.chat.voiceInput}>{speech.listening ? '■' : '●'}</button> : null}
    <button className="button button--primary composer__send" data-testid="send-btn" type="submit" disabled={disabled || !value.trim()}>{copy.chat.send}</button>
  </form>;
}
