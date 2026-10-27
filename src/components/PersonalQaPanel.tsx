import { useEffect, useRef, useState } from 'react';
import { copy } from '../copy';
import { usePresence } from '../hooks/usePresence';
import type { PersonalQaEntry } from '../lib/personalQa';

interface PersonalQaPanelProps {
  open: boolean;
  entries: PersonalQaEntry[];
  onClose: () => void;
  onSave: (entry: Pick<PersonalQaEntry, 'id' | 'question' | 'answer'>) => void;
  onRemove: (id: string) => void;
}

function makeId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `personal-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function PersonalQaPanel({ open, entries, onClose, onSave, onRemove }: PersonalQaPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);
  const presence = usePresence(open);

  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  if (!presence.mounted) return null;

  const beginEdit = (entry?: PersonalQaEntry): void => {
    setEditingId(entry?.id ?? null);
    setQuestion(entry?.question ?? '');
    setAnswer(entry?.answer ?? '');
  };

  const save = (): void => {
    const cleanQuestion = question.trim();
    const cleanAnswer = answer.trim();
    if (!cleanQuestion || !cleanAnswer) return;
    onSave({ id: editingId ?? makeId(), question: cleanQuestion, answer: cleanAnswer });
    setEditingId(null);
    setQuestion('');
    setAnswer('');
  };

  return (
    <div className={`upload-backdrop${presence.closing ? ' is-closing' : ''}`} role="presentation" onMouseDown={onClose}>
      <section className="upload-panel personal-panel" role="dialog" aria-modal="true" aria-label={copy.chat.personalTitle} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
        <header>
          <h2>{copy.chat.personalTitle}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={copy.chat.back}>×</button>
        </header>
        <p>{copy.chat.personalDescription}</p>
        <p>{copy.chat.personalPrivacy}</p>
        <div className="personal-list">
          {entries.length === 0 ? <p>{copy.chat.personalEmpty}</p> : entries.map((entry) => (
            <article className="personal-entry" key={entry.id}>
              <strong>{entry.question}</strong>
              <p>{entry.answer}</p>
              <button type="button" onClick={() => beginEdit(entry)}>{copy.chat.personalEdit}</button>
              <button type="button" onClick={() => onRemove(entry.id)}>{copy.chat.personalRemove}</button>
            </article>
          ))}
        </div>
        <div className="personal-form">
          <label>{copy.chat.personalQuestion}<input value={question} maxLength={200} onChange={(event) => setQuestion(event.target.value)} /></label>
          <label>{copy.chat.personalAnswer}<textarea value={answer} maxLength={2000} rows={4} onChange={(event) => setAnswer(event.target.value)} /></label>
          <button className="button button--primary" type="button" disabled={!question.trim() || !answer.trim()} onClick={save}>{editingId ? copy.chat.personalSave : copy.chat.personalAdd}</button>
          {editingId ? <button className="text-button" type="button" onClick={() => beginEdit()}>{copy.chat.personalCancel}</button> : null}
        </div>
      </section>
    </div>
  );
}
