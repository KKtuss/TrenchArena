import type { ObjectReadWriteStream } from 'pokemon-showdown/dist/lib/streams';

export interface ChoiceRequest {
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: boolean[];
  active?: Array<ActiveRequest | null>;
  side?: {
    pokemon?: PokemonState[];
  };
}

interface ActiveRequest {
  trapped?: boolean;
  moves?: MoveOption[];
}

interface MoveOption {
  disabled?: boolean;
  target?: string;
}

interface PokemonState {
  active?: boolean;
  condition?: string;
}

export class MalformedChoiceError extends Error {
  constructor(choice: string) {
    super(`Malformed or illegal deterministic choice: ${choice}`);
    this.name = 'MalformedChoiceError';
  }
}

export class StaleChoiceError extends Error {
  constructor(revision: number) {
    super(`Choice revision ${revision} is stale.`);
    this.name = 'StaleChoiceError';
  }
}

export function parseChoiceRequests(chunk: string): ChoiceRequest[] {
  const requests: ChoiceRequest[] = [];

  for (const line of chunk.split('\n')) {
    if (!line.startsWith('|request|')) continue;

    const parsed: unknown = JSON.parse(line.slice('|request|'.length));
    if (!isRecord(parsed)) {
      throw new Error('Showdown returned a non-object choice request.');
    }
    requests.push(parsed as ChoiceRequest);
  }

  return requests;
}

export function chooseFirstLegalChoice(request: ChoiceRequest): string | null {
  if (request.wait) return null;
  if (request.teamPreview) return 'default';

  if (request.forceSwitch) {
    return request.forceSwitch.map((mustSwitch, activeIndex) => {
      if (!mustSwitch) return 'pass';

      const pokemon = request.side?.pokemon ?? [];
      const switchIndex = pokemon.findIndex((candidate, candidateIndex) => (
        candidateIndex !== activeIndex &&
        !candidate.active &&
        !candidate.condition?.endsWith(' fnt')
      ));

      return switchIndex >= 0 ? `switch ${switchIndex + 1}` : 'pass';
    }).join(', ');
  }

  const active = request.active?.[0];
  if (!active) {
    throw new Error('Unsupported Showdown request: no team preview, switch, or active choice.');
  }

  const moveIndex = active.moves?.findIndex(move => !move.disabled) ?? -1;
  if (moveIndex >= 0) return `move ${moveIndex + 1}`;

  if (!active.trapped) {
    const switchIndex = (request.side?.pokemon ?? []).findIndex(candidate => (
      !candidate.active && !candidate.condition?.endsWith(' fnt')
    ));
    if (switchIndex >= 0) return `switch ${switchIndex + 1}`;
  }

  throw new Error('No legal deterministic choice was available.');
}

/**
 * This gate is deliberately narrow: it models the request-revision and
 * server-side choice checks that a future WebSocket gateway must enforce.
 */
export class ChoiceController {
  private revision = 0;
  private pending: { revision: number; choice: string } | null = null;

  accept(request: ChoiceRequest): number {
    const choice = chooseFirstLegalChoice(request);
    if (choice === null) return ++this.revision;

    this.revision += 1;
    this.pending = { revision: this.revision, choice };
    return this.revision;
  }

  submit(revision: number, choice: string): string {
    if (!this.pending || revision !== this.pending.revision) {
      throw new StaleChoiceError(revision);
    }
    if (choice !== this.pending.choice) {
      throw new MalformedChoiceError(choice);
    }

    this.pending = null;
    return choice;
  }

  get currentRevision(): number {
    return this.revision;
  }
}

export interface PlayerDriverResult {
  events: string[];
  choices: Array<{ revision: number; choice: string }>;
}

export async function driveDeterministicPlayer(
  stream: ObjectReadWriteStream<string>,
  result: PlayerDriverResult,
  maxChoices = 1000,
): Promise<void> {
  const controller = new ChoiceController();

  for await (const chunk of stream) {
    result.events.push(chunk);

    for (const request of parseChoiceRequests(chunk)) {
      const revision = controller.accept(request);
      const choice = chooseFirstLegalChoice(request);
      if (choice === null) continue;

      if (result.choices.length >= maxChoices) {
        throw new Error(`Player exceeded the ${maxChoices}-choice safety limit.`);
      }

      const acceptedChoice = controller.submit(revision, choice);
      result.choices.push({ revision, choice: acceptedChoice });
      await stream.write(acceptedChoice);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
