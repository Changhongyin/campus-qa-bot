import { useCallback, useEffect, useRef, useState } from 'react';

function splitText(text: string): string[] {
  return text.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.flatMap((item) => {
    const parts: string[] = [];
    for (let index = 0; index < item.length; index += 120) parts.push(item.slice(index, index + 120));
    return parts;
  }) ?? [];
}

/** Strip markdown / source tags / URLs so the answer reads naturally aloud. */
export function toSpeechText(text: string): string {
  return text
    .replace(/【[^】]*】/g, '')                 // 【来源：…】
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links -> label
    .replace(/\*\*(.*?)\*\*/g, '$1')           // bold
    .replace(/https?:\/\/\S+/g, '')            // bare URLs
    .replace(/[\u0060*_>#|]/g, '')             // stray markdown marks
    .replace(/\s+/g, ' ')
    .trim();
}

export function useSpeechSynthesis() {
  const supported = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [enabled, setEnabled] = useState(() => localStorage.getItem('ldzd-tts') === 'true');
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const timerRef = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (!supported) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    window.speechSynthesis.cancel();
  }, [supported]);

  useEffect(() => {
    if (!supported) return;
    const select = (): void => {
      const voices = window.speechSynthesis.getVoices();
      const zh = voices.filter((voice) => voice.lang.toLowerCase().startsWith('zh'));
      voiceRef.current =
        zh.find((voice) => voice.lang.toLowerCase() === 'zh-cn' && voice.localService) ??
        zh.find((voice) => voice.lang.toLowerCase() === 'zh-cn') ??
        zh[0] ??
        null;
    };
    select();
    window.speechSynthesis.addEventListener('voiceschanged', select);
    return () => {
      window.speechSynthesis.removeEventListener('voiceschanged', select);
      window.speechSynthesis.cancel();
    };
  }, [supported]);

  const setPreference = useCallback((value: boolean): void => {
    setEnabled(value);
    localStorage.setItem('ldzd-tts', String(value));
    if (!value) cancel();
  }, [cancel]);

  const speak = useCallback((text: string): void => {
    if (!supported) return;
    const parts = splitText(toSpeechText(text));
    if (parts.length === 0) return;
    cancel();
    // Chrome can drop utterances queued in the same tick as cancel(); re-queue next tick.
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      for (const part of parts) {
        const utterance = new SpeechSynthesisUtterance(part);
        if (voiceRef.current) {
          utterance.voice = voiceRef.current;
          utterance.lang = voiceRef.current.lang;
        } else {
          utterance.lang = 'zh-CN';
        }
        utterance.rate = 0.98;
        utterance.pitch = 1;
        window.speechSynthesis.speak(utterance);
      }
    }, 80);
  }, [cancel, supported]);

  return { supported, enabled, setEnabled: setPreference, speak, cancel };
}
