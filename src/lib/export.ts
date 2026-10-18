import type { Message } from '../types';
import type { PersonalQaEntry } from './personalQa';

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function exportConversation(
  messages: Message[],
  includePersonal: boolean,
  personalEntries: PersonalQaEntry[],
): boolean {
  if (messages.length === 0) return false;

  const lines = ['# Liangda Zhida conversation', '', `Exported: ${new Date().toISOString()}`, ''];

  messages.forEach((message) => {
    const role = message.role === 'user' ? 'User' : 'Assistant';
    lines.push(`## ${role}`, '', message.content, '');
    lines.push(`Time: ${new Date(message.createdAt).toISOString()}`, '');

    if (message.sources && message.sources.length > 0) {
      lines.push(`Sources: ${message.sources.map(escapeCell).join(', ')}`, '');
    }

    if (message.thoughts && message.thoughts.length > 0) {
      lines.push('Thought trail:', '');
      message.thoughts.forEach((thought) => {
        lines.push(`- ${thought.stage}: ${thought.text} (${thought.ms} ms)`);
      });
      lines.push('');
    }
  });

  if (includePersonal && personalEntries.length > 0) {
    lines.push('## Personal Q&A', '');
    personalEntries.forEach((entry) => {
      lines.push(`### ${entry.question}`, '', entry.answer, '');
    });
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ldzd-conversation-${new Date().toISOString().slice(0, 10)}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}
