const storageKey = 'ldzd-personal-qa';

export interface PersonalQaEntry {
  id: string;
  question: string;
  answer: string;
  updatedAt: number;
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function readEntries(): PersonalQaEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is PersonalQaEntry => {
      if (typeof entry !== 'object' || entry === null) return false;
      const item = entry as Record<string, unknown>;
      return typeof item.id === 'string'
        && typeof item.question === 'string'
        && typeof item.answer === 'string'
        && typeof item.updatedAt === 'number';
    });
  } catch {
    return [];
  }
}

function writeEntries(entries: PersonalQaEntry[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(entries));
  } catch {
    return;
  }
}

function bigrams(value: string): Set<string> {
  const characters = Array.from(normalize(value));
  const result = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    result.add(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

function similarity(left: string, right: string): number {
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  if (leftPairs.size === 0 || rightPairs.size === 0) return 0;
  let shared = 0;
  leftPairs.forEach((pair) => {
    if (rightPairs.has(pair)) shared += 1;
  });
  return (2 * shared) / (leftPairs.size + rightPairs.size);
}

export function listPersonalQa(): PersonalQaEntry[] {
  return readEntries().sort((left, right) => right.updatedAt - left.updatedAt);
}

export function savePersonalQa(entry: Pick<PersonalQaEntry, 'id' | 'question' | 'answer'>): PersonalQaEntry[] {
  const current = readEntries().filter((item) => item.id !== entry.id);
  current.push({ ...entry, updatedAt: Date.now() });
  writeEntries(current);
  return listPersonalQa();
}

export function removePersonalQa(id: string): PersonalQaEntry[] {
  const updated = readEntries().filter((entry) => entry.id !== id);
  writeEntries(updated);
  return listPersonalQa();
}

export function matchPersonalQa(question: string): PersonalQaEntry | null {
  const normalized = normalize(question);
  if (!normalized) return null;
  const entries = readEntries();
  const exact = entries.find((entry) => normalize(entry.question) === normalized);
  if (exact) return exact;
  return entries.find((entry) => similarity(entry.question, normalized) >= 0.82) ?? null;
}
