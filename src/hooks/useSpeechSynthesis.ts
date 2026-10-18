import { useCallback, useEffect, useRef, useState } from 'react';

function splitText(text: string): string[] {
  return text.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.flatMap((item) => {
    const parts: string[] = [];
    for (let index = 0; index < item.length; index += 120) parts.push(item.slice(index, index + 120));
    return parts;
  }) ?? [];
}

export function useSpeechSynthesis() {
  const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [enabled, setEnabled] = useState(() => localStorage.getItem('ldzd-tts') === 'true');
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);

  const cancel = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const select = (): void => {
      const voices = window.speechSynthesis.getVoices();
      voiceRef.current = voices.find((voice) => voice.lang.toLowerCase() === 'zh-cn' && voice.localService)
        ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('zh'))
        ?? null;
    };
    select();
    window.speechSynthesis.addEventListener('voiceschanged', select);
    return () => { window.speechSynthesis.removeEventListener('voiceschanged', select); window.speechSynthesis.cancel(); };
  }, [supported]);

  const setPreference = useCallback((value: boolean): void => {
    setEnabled(value);
    localStorage.setItem('ldzd-tts', String(value));
    if (!value) cancel();
  }, [cancel]);

  const speak = useCallback((text: string): void => {
    if (!enabled || !supported || !text.trim()) return;
    cancel();
    splitText(text).forEach((part) => {
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = 'zh-CN';
      utterance.voice = voiceRef.current;
      window.speechSynthesis.speak(utterance);
    });
  }, [cancel, enabled, supported]);

  return { supported, enabled, setEnabled: setPreference, speak, cancel };
}
