import { BattleStream, getPlayerStreams } from 'pokemon-showdown';

import {
  driveDeterministicPlayer,
  type PlayerDriverResult,
} from './driver';
import {
  FORMAT_ID,
  TEAM_ONE,
  TEAM_TWO,
  validateAndPackTeam,
} from './teams';

export const SHOWDOWN_VERSION = '0.11.11';
export const SHOWDOWN_GIT_HEAD = '739a5e1fee432ad80ff7136d70cca993be358b59';
export const DEFAULT_SEED = '1,2,3,4';

export interface TerminalResult {
  winner: string;
  score: number[];
  turns: number;
  p1: string;
  p2: string;
}

export interface BattleEventLog {
  raw: string[];
  omniscient: string[];
  spectator: string[];
  p1: string[];
  p2: string[];
}

export interface BattleRunResult {
  formatId: string;
  showdownVersion: string;
  showdownGitHead: string;
  terminal: TerminalResult;
  inputLog: string[];
  eventLog: BattleEventLog;
  players: {
    p1: PlayerDriverResult;
    p2: PlayerDriverResult;
  };
}

interface RawTerminalData {
  winner?: unknown;
  score?: unknown;
  turns?: unknown;
  p1?: unknown;
  p2?: unknown;
  inputLog?: unknown;
}

class RecordingBattleStream extends BattleStream {
  readonly rawMessages: string[] = [];
  private readonly terminalPromise: Promise<TerminalResult>;
  private resolveTerminal!: (result: TerminalResult) => void;
  private rejectTerminal!: (error: Error) => void;

  constructor() {
    super();
    this.terminalPromise = new Promise<TerminalResult>((resolve, reject) => {
      this.resolveTerminal = resolve;
      this.rejectTerminal = reject;
    });
  }

  override push(chunk: string): void {
    this.rawMessages.push(chunk);

    if (chunk.startsWith('end\n')) {
      try {
        const data: unknown = JSON.parse(chunk.slice('end\n'.length));
        this.resolveTerminal(normalizeTerminalResult(data));
      } catch (error) {
        this.rejectTerminal(error instanceof Error ? error : new Error(String(error)));
      }
    }

    super.push(chunk);
  }

  async waitForTerminal(timeoutMs = 15_000): Promise<TerminalResult> {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Battle did not finish within ${timeoutMs}ms.`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([this.terminalPromise, deadline]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

export async function runBattle(
  seed = DEFAULT_SEED,
  maxChoices = 1000,
): Promise<BattleRunResult> {
  const p1Team = validateAndPackTeam(TEAM_ONE);
  const p2Team = validateAndPackTeam(TEAM_TWO);
  const stream = new RecordingBattleStream();
  const playerStreams = getPlayerStreams(stream);
  const eventLog: BattleEventLog = {
    raw: stream.rawMessages,
    omniscient: [],
    spectator: [],
    p1: [],
    p2: [],
  };
  const p1: PlayerDriverResult = { events: eventLog.p1, choices: [] };
  const p2: PlayerDriverResult = { events: eventLog.p2, choices: [] };

  const omniscientPromise = collect(playerStreams.omniscient, eventLog.omniscient);
  const spectatorPromise = collect(playerStreams.spectator, eventLog.spectator);
  const p1Promise = driveDeterministicPlayer(playerStreams.p1, p1, maxChoices);
  const p2Promise = driveDeterministicPlayer(playerStreams.p2, p2, maxChoices);

  await stream.write([
    `>start ${JSON.stringify({ formatid: FORMAT_ID, seed })}`,
    `>player p1 ${JSON.stringify({ name: 'Alice', team: p1Team })}`,
    `>player p2 ${JSON.stringify({ name: 'Bob', team: p2Team })}`,
  ].join('\n'));

  const terminal = await stream.waitForTerminal();
  await Promise.all([
    omniscientPromise,
    spectatorPromise,
    p1Promise,
    p2Promise,
  ]);

  const inputLog = readInputLog(stream.rawMessages);
  assertTerminalProtocol(eventLog.omniscient, terminal);
  assertPublicStreamIsPrivateSafe(eventLog.spectator);

  return {
    formatId: FORMAT_ID,
    showdownVersion: SHOWDOWN_VERSION,
    showdownGitHead: SHOWDOWN_GIT_HEAD,
    terminal,
    inputLog,
    eventLog,
    players: { p1, p2 },
  };
}

export async function replayBattle(inputLog: string[]): Promise<TerminalResult> {
  if (!inputLog.length) throw new Error('Cannot replay an empty input log.');

  const stream = new RecordingBattleStream();
  await stream.write(inputLog.join('\n'));
  return stream.waitForTerminal();
}

export function assertSameTerminalResult(
  expected: TerminalResult,
  actual: TerminalResult,
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error([
      'Replay terminal result differs.',
      `Expected: ${JSON.stringify(expected)}`,
      `Actual: ${JSON.stringify(actual)}`,
    ].join('\n'));
  }
}

function normalizeTerminalResult(value: unknown): TerminalResult {
  if (!isRecord(value)) throw new Error('Showdown terminal data is not an object.');

  const score = value.score;
  if (
    !Array.isArray(score) ||
    !score.every(item => typeof item === 'number')
  ) {
    throw new Error('Showdown terminal data has no numeric score.');
  }

  if (typeof value.turns !== 'number') {
    throw new Error('Showdown terminal data has no turn count.');
  }

  const winner = value.winner;
  if (winner !== undefined && typeof winner !== 'string') {
    throw new Error('Showdown terminal data has an invalid winner.');
  }

  return {
    winner: winner ?? '',
    score,
    turns: value.turns,
    p1: typeof value.p1 === 'string' ? value.p1 : '',
    p2: typeof value.p2 === 'string' ? value.p2 : '',
  };
}

function readInputLog(rawMessages: string[]): string[] {
  const endMessage = rawMessages.find(message => message.startsWith('end\n'));
  if (!endMessage) throw new Error('Battle ended without an end message.');

  const data: unknown = JSON.parse(endMessage.slice('end\n'.length));
  if (!isRecord(data) || !Array.isArray(data.inputLog)) {
    throw new Error('Battle end message did not contain an input log.');
  }
  if (!data.inputLog.every(item => typeof item === 'string')) {
    throw new Error('Battle input log contained a non-string command.');
  }
  return data.inputLog;
}

function assertTerminalProtocol(
  omniscientEvents: string[],
  terminal: TerminalResult,
): void {
  const lines = omniscientEvents.flatMap(event => event.split('\n'));
  const winLine = lines.find(line => line.startsWith('|win|'));
  const tieLine = lines.find(line => line === '|tie');

  if (terminal.winner) {
    if (winLine !== `|win|${terminal.winner}`) {
      throw new Error('Terminal winner did not match the omniscient protocol.');
    }
  } else if (!tieLine) {
    throw new Error('Terminal tie did not match the omniscient protocol.');
  }
}

function assertPublicStreamIsPrivateSafe(spectatorEvents: string[]): void {
  const leakedRequest = spectatorEvents.some(event => event.includes('|request|'));
  const leakedSplit = spectatorEvents.some(event => event.includes('|split|'));
  if (leakedRequest || leakedSplit) {
    throw new Error('Spectator stream contained player-private protocol data.');
  }
}

async function collect(
  stream: AsyncIterable<string>,
  destination: string[],
): Promise<void> {
  for await (const chunk of stream) destination.push(chunk);
}

function isRecord(value: unknown): value is RawTerminalData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
