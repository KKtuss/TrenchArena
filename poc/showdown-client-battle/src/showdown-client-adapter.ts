/**
 * ShowdownClientAdapter
 *
 * Presentation-only bridge between PokeArena BattleEngine events and the
 * Pokémon Showdown client battle renderer / choice builder.
 *
 * Authority stays in BattleEngine. This module never invents legal choices,
 * winners, or ownership.
 */

export interface ProtocolEventLike {
  sequence: number;
  scope: 'public' | 'private';
  playerId?: string;
  kind: string;
  data: string;
}

export interface ShowdownFeedChunk {
  /** Lines suitable for `battle.add(line)` / stepQueue */
  publicLines: string[];
  /** Raw `|request|{json}` payloads for the authenticated player only */
  requestPayloads: unknown[];
}

/**
 * Split filtered BattleEngine events into Showdown protocol lines.
 * Callers must already have filtered events for the viewing player.
 */
export function eventsToShowdownFeed(
  events: readonly ProtocolEventLike[],
  fromSequence = 0,
): ShowdownFeedChunk {
  const publicLines: string[] = [];
  const requestPayloads: unknown[] = [];

  for (const event of events) {
    if (event.sequence <= fromSequence) continue;
    if (event.kind !== 'protocol') continue;

    for (const rawLine of event.data.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;

      if (line.startsWith('|request|')) {
        if (event.scope !== 'private') continue;
        const json = line.slice('|request|'.length);
        try {
          requestPayloads.push(JSON.parse(json));
        } catch {
          // Malformed request JSON is ignored at the adapter edge; BattleEngine
          // already validated requests before storing them.
        }
        continue;
      }

      // Public battle protocol only — never feed foreign private chunks.
      if (event.scope === 'public') {
        publicLines.push(line);
      }
    }
  }

  return { publicLines, requestPayloads };
}

/**
 * Convert a completed Showdown choice string (`move 1`, `switch 3`,
 * `move 2 terastallize`, `default`, `pass`) into a PokeArena typed choice.
 *
 * Does not authorize the choice — BattleEngine still validates against the
 * current request revision.
 */
export function showdownChoiceToPlayerChoice(choiceText: string): {
  type: 'team-preview' | 'move' | 'switch' | 'pass';
  slot?: number;
  target?: number;
  terastallize?: boolean;
} {
  const normalized = choiceText.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Choice text must not be empty.');

  if (
    normalized === 'default'
    || normalized === 'team'
    || normalized.startsWith('team ')
  ) {
    return { type: 'team-preview' };
  }

  if (normalized === 'pass') {
    return { type: 'pass' };
  }

  const move = normalized.match(
    /^move\s+(\d+)(?:\s+(-?\d+))?(?:\s+(terastallize|terastal|mega|zmove|max|dynamax))*?$/,
  );
  if (move) {
    const slot = Number(move[1]);
    const target = move[2] !== undefined ? Number(move[2]) : undefined;
    const terastallize = /\b(terastallize|terastal)\b/.test(normalized);
    return {
      type: 'move',
      slot,
      ...(target !== undefined ? { target } : {}),
      ...(terastallize ? { terastallize: true } : {}),
    };
  }

  const switchMatch = normalized.match(/^switch\s+(\d+)$/);
  if (switchMatch) {
    return { type: 'switch', slot: Number(switchMatch[1]) };
  }

  throw new Error(`Unsupported Showdown choice string: ${choiceText}`);
}

/**
 * Normalize Showdown request objects so BattleChoiceBuilder-style UIs can
 * consume them. Showdown's formRequest mutates the battle side in the real
 * client; we only pass through the JSON here.
 */
export function latestRequestPayload(payloads: unknown[]): unknown | undefined {
  return payloads.length ? payloads[payloads.length - 1] : undefined;
}
