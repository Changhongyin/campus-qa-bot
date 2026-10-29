import type { ChatMode, Message, Thought, View } from '../types';

const databaseName = 'ldzd-chat';
const storeName = 'state';
const recordKey = 'conversation';
const viewKey = 'ldzd-view';
const ttsKey = 'ldzd-tts';

export interface PersistedConversation {
  messages: Message[];
  thoughts: Thought[];
  mode: ChatMode;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function loadConversation(): Promise<PersistedConversation | null> {
  try {
    const database = await openDatabase();

    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(recordKey);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const value: unknown = request.result;
        resolve(
          typeof value === 'object' && value !== null
            ? (value as PersistedConversation)
            : null,
        );
      };
    });
  } catch {
    return null;
  }
}

export async function saveConversation(value: PersistedConversation): Promise<void> {
  try {
    const database = await openDatabase();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(value, recordKey);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
  } catch {
    return;
  }
}

export async function clearConversation(): Promise<void> {
  try {
    const database = await openDatabase();

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(recordKey);
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
  } catch {
    return;
  }
}

export function loadView(): View {
  try {
    return window.localStorage.getItem(viewKey) === 'chat' ? 'chat' : 'landing';
  } catch {
    return 'landing';
  }
}

export function saveView(view: View): void {
  try {
    window.localStorage.setItem(viewKey, view);
  } catch {
    return;
  }
}

export function loadTtsEnabled(): boolean {
  try {
    return window.localStorage.getItem(ttsKey) === 'true';
  } catch {
    return false;
  }
}

export function saveTtsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(ttsKey, String(enabled));
  } catch {
    return;
  }
}

const eggMutedKey = 'ldzd-egg-muted';

export function loadEggMuted(): boolean {
  try {
    return window.localStorage.getItem(eggMutedKey) === 'true';
  } catch {
    return false;
  }
}

export function saveEggMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(eggMutedKey, String(muted));
  } catch {
    return;
  }
}
