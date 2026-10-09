const STORAGE_KEY = 'pokearena.auto-opened-fights';

export function openedFightIds(): Set<string> {
  if (typeof sessionStorage === 'undefined') return new Set();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

export function markOpenedFight(matchId: string): void {
  if (!matchId || typeof sessionStorage === 'undefined') return;
  const ids = openedFightIds();
  if (ids.has(matchId)) return;
  ids.add(matchId);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Private browsing can reject the write. The fight still opens once.
  }
}
