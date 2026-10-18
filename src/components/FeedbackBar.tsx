import { useState } from 'react';
import { submitFeedback } from '../lib/api';

export function FeedbackBar({ requestId }: { requestId?: string }) {
  const [sent, setSent] = useState<'up' | 'down' | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (rating: 'up' | 'down'): Promise<void> => {
    if (busy || sent === rating) return;
    setBusy(true);
    try { await submitFeedback({ requestId, rating }); setSent(rating); } catch { setSent(rating); } finally { setBusy(false); }
  };

  return (
    <div className="feedback">
      <button data-testid="feedback-up" type="button" disabled={busy || sent === 'up'} onClick={() => void send('up')}>👍</button>
      <button data-testid="feedback-down" type="button" disabled={busy || sent === 'down'} onClick={() => void send('down')}>👎</button>
    </div>
  );
}
