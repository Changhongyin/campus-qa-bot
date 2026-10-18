import { copy } from '../copy';
import type { ChatMode } from '../types';

export function StatusPill({ mode }: { mode: ChatMode }) {
  return <span className={`status-pill status-pill--${mode}`}>{mode === 'unknown' ? copy.chat.offline : mode}</span>;
}
