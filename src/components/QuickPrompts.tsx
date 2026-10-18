import { copy } from '../copy';

interface QuickPromptsProps {
  disabled: boolean;
  onSelect: (text: string) => Promise<void>;
}

export function QuickPrompts({ disabled, onSelect }: QuickPromptsProps) {
  return (
    <div className="quick-prompts" aria-label={copy.app.title}>
      {copy.chat.quickPrompts.map((prompt) => (
        <button key={prompt} type="button" disabled={disabled} onClick={() => void onSelect(prompt)}>
          {prompt}
        </button>
      ))}
    </div>
  );
}
