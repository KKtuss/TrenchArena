import type { PlayerChoice } from './protocol';

export interface ProtocolEventLike {
  sequence: number;
  scope: 'public' | 'private';
  playerId?: string;
  kind: string;
  data: string;
}

export interface ShowdownFeedChunk {
  publicLines: string[];
  requestPayloads: unknown[];
  lastSequence: number;
}

/**
 * Convert already viewer-filtered BattleEngine events into the two inputs the
 * Showdown client needs: public battle protocol and the viewer's private
 * request JSON.
 */
export function eventsToShowdownFeed(
  events: readonly ProtocolEventLike[],
  fromSequence = 0,
  viewerId?: string,
): ShowdownFeedChunk {
  const publicLines: string[] = [];
  const requestPayloads: unknown[] = [];
  let lastSequence = fromSequence;

  for (const event of events) {
    if (event.sequence <= fromSequence) continue;
    lastSequence = Math.max(lastSequence, event.sequence);
    if (event.kind !== 'protocol') continue;

    for (const rawLine of event.data.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      if (line.startsWith('|request|')) {
        if (event.scope !== 'private') continue;
        if (viewerId && event.playerId !== viewerId) continue;
        try {
          requestPayloads.push(JSON.parse(line.slice('|request|'.length)));
        } catch {
          // BattleEngine has already validated requests; malformed payloads
          // are ignored at the presentation boundary.
        }
        continue;
      }

      if (event.scope === 'public') publicLines.push(line);
    }
  }

  return { publicLines, requestPayloads, lastSequence };
}

export function showdownChoiceToPlayerChoice(choiceText: string): PlayerChoice {
  const normalized = choiceText.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Choice text must not be empty.');

  if (
    normalized === 'default'
    || normalized === 'team'
    || normalized.startsWith('team ')
  ) {
    return { type: 'team-preview' };
  }
  if (normalized === 'pass') return { type: 'pass' };

  const move = normalized.match(
    /^move\s+(\d+)(?:\s+(-?\d+))?(?:\s+(terastallize|terastal|mega|zmove|max|dynamax))*$/,
  );
  if (move) {
    const slot = Number(move[1]);
    const target = move[2] === undefined ? undefined : Number(move[2]);
    const terastallize = /\b(terastallize|terastal)\b/.test(normalized);
    return {
      type: 'move',
      slot,
      ...(target === undefined ? {} : { target }),
      ...(terastallize ? { terastallize: true } : {}),
    };
  }

  const switchMatch = normalized.match(/^switch\s+(\d+)$/);
  if (switchMatch) return { type: 'switch', slot: Number(switchMatch[1]) };

  throw new Error(`Unsupported Showdown choice string: ${choiceText}`);
}

export function latestRequestPayload(payloads: readonly unknown[]): unknown | undefined {
  return payloads.length ? payloads[payloads.length - 1] : undefined;
}

/**
 * A renderer that has not applied any lines yet should jump to the current
 * protocol state when that log is already past the opening. Incremental
 * lines keep animating.
 */
export function shouldCatchUpShowdownFeed(
  fromSequence: number,
  publicLines: readonly string[],
): boolean {
  if (fromSequence > 0 || publicLines.length === 0) return false;
  return publicLines.some(line => (
    line.startsWith('|win|')
    || line.startsWith('|tie|')
    || /^\|turn\|[1-9]/.test(line)
  ));
}
