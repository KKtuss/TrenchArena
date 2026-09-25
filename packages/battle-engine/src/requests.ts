import { InvalidChoiceError } from './errors';
import type {
  AvailableChoice,
  PlayerChoice,
  PlayerId,
  PlayerRequest,
} from './types';

interface ShowdownRequest {
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: boolean[];
  active?: Array<ShowdownActiveRequest | null>;
  side?: {
    pokemon?: ShowdownPokemon[];
  };
}

interface ShowdownActiveRequest {
  trapped?: boolean;
  canTerastallize?: unknown;
  moves?: Array<{ disabled?: boolean }>;
}

interface ShowdownPokemon {
  active?: boolean;
  condition?: string;
}

export function parseChoiceRequests(chunk: string): ShowdownRequest[] {
  const requests: ShowdownRequest[] = [];

  for (const line of chunk.split('\n')) {
    if (!line.startsWith('|request|')) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice('|request|'.length));
    } catch (error) {
      throw new Error(`Showdown returned malformed request JSON: ${String(error)}`);
    }
    if (!isRecord(parsed)) {
      throw new Error('Showdown returned a non-object choice request.');
    }
    requests.push(parsed as ShowdownRequest);
  }

  return requests;
}

export function normalizeRequest(
  playerId: PlayerId,
  revision: number,
  request: ShowdownRequest,
): PlayerRequest {
  if (request.wait) {
    return { playerId, revision, kind: 'wait', choices: [] };
  }
  if (request.teamPreview) {
    return { playerId, revision, kind: 'team-preview', choices: [{ type: 'team-preview' }] };
  }

  if (request.forceSwitch) {
    const choices = normalizeSwitchChoices(request);
    return {
      playerId,
      revision,
      kind: 'switch',
      choices: choices.length ? choices : [{ type: 'pass' }],
    };
  }

  const active = request.active?.[0];
  if (!active) {
    throw new Error('Showdown returned a request with no actionable state.');
  }

  const choices: AvailableChoice[] = [];
  for (const [index, move] of (active.moves ?? []).entries()) {
    if (!move.disabled) {
      choices.push({
        type: 'move',
        slot: index + 1,
        terastallize: Boolean(active.canTerastallize),
      });
    }
  }

  if (!active.trapped) choices.push(...normalizeSwitchChoices(request));
  if (!choices.length) throw new Error('Showdown returned no legal choices.');

  return { playerId, revision, kind: 'move', choices };
}

export function choiceToCommand(
  request: PlayerRequest,
  choice: PlayerChoice,
): string {
  if (!isRecord(choice) || typeof choice.type !== 'string') {
    throw new InvalidChoiceError('Choice must be a typed choice object.');
  }

  switch (choice.type) {
    case 'team-preview':
      if (request.choices.some(item => item.type === 'team-preview')) return 'default';
      break;
    case 'pass':
      if (request.choices.some(item => item.type === 'pass')) return 'pass';
      break;
    case 'switch':
      if (
        Number.isInteger(choice.slot) &&
        request.choices.some(item => item.type === 'switch' && item.slot === choice.slot)
      ) {
        return `switch ${choice.slot}`;
      }
      break;
    case 'move': {
      if (
        !Number.isInteger(choice.slot) ||
        (choice.target !== undefined && !Number.isInteger(choice.target)) ||
        (choice.terastallize !== undefined && typeof choice.terastallize !== 'boolean')
      ) {
        throw new InvalidChoiceError('Move choice contains invalid numeric or boolean fields.');
      }
      const action = request.choices.find(item => (
        item.type === 'move' && item.slot === choice.slot
      ));
      if (action?.type === 'move' && (!choice.terastallize || action.terastallize)) {
        let command = `move ${choice.slot}`;
        if (choice.target !== undefined) command += ` ${choice.target}`;
        if (choice.terastallize) command += ' terastallize';
        return command;
      }
      break;
    }
    default:
      break;
  }

  throw new InvalidChoiceError(
    `Choice is not available in request revision ${request.revision}.`,
  );
}

function normalizeSwitchChoices(request: ShowdownRequest): AvailableChoice[] {
  const pokemon = request.side?.pokemon ?? [];
  const choices: AvailableChoice[] = [];
  for (const [index, candidate] of pokemon.entries()) {
    if (!candidate.active && !candidate.condition?.endsWith(' fnt')) {
      choices.push({ type: 'switch', slot: index + 1 });
    }
  }
  return choices;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
