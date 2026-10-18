import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface RecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

interface RecognitionConstructor {
  new (): RecognitionInstance;
}

export function useSpeechInput(onText: (text: string) => void) {
  const win = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const Constructor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<RecognitionInstance | null>(null);

  useEffect(() => () => recognitionRef.current?.stop(), []);

  const toggle = useCallback(() => {
    if (!Constructor) return;
    if (listening) { recognitionRef.current?.stop(); return; }
    const recognition = new Constructor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let text = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) text += event.results[index][0].transcript;
      onText(text);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [Constructor, listening, onText]);

  return { supported: Boolean(Constructor), listening, toggle };
}
