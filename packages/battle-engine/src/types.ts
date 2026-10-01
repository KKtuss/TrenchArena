export const SUPPORTED_FORMATS = ['gen9ou'] as const;

export type SupportedFormat = typeof SUPPORTED_FORMATS[number];
export type PlayerId = string;
export type BattleViewer = 'spectator' | PlayerId;
export type BattleLifecycle = 'created' | 'started' | 'awaiting-choice' | 'ended' | 'failed';

export interface BattlePlayerInput {
  id: PlayerId;
  name?: string;
}

export interface CreateBattleInput {
  format: SupportedFormat;
  players: readonly [BattlePlayerInput, BattlePlayerInput];
  teams: readonly [string, string];
  seed?: string;
  timeoutMs?: number;
  /** Showdown formatid used for validation and `>start`. Defaults to `format`. */
  showdownFormatId?: string;
  /** Required number of Pokémon in each team paste. Defaults to 6. */
  teamSize?: number;
}

export interface BattlePlayer {
  id: PlayerId;
  name: string;
}

export type PlayerChoice =
  | { type: 'team-preview' }
  | { type: 'move'; slot: number; target?: number; terastallize?: boolean }
  | { type: 'switch'; slot: number }
  | { type: 'pass' };

export interface ChoiceSubmission {
  battleId: string;
  playerId: PlayerId;
  revision: number;
  choice: PlayerChoice;
}

export type AvailableChoice =
  | { type: 'team-preview' }
  | { type: 'move'; slot: number; terastallize: boolean }
  | { type: 'switch'; slot: number }
  | { type: 'pass' };

export interface PlayerRequest {
  playerId: PlayerId;
  revision: number;
  kind: 'team-preview' | 'move' | 'switch' | 'wait';
  choices: readonly AvailableChoice[];
}

export interface BattleResult {
  status: 'win' | 'tie';
  winner?: PlayerId;
  score: readonly number[];
  turns: number;
  /** Set when the current decision deadline elapsed with a player still owing a move. */
  endedBy?: 'timeout';
}

export interface BattleFailure {
  code: 'timeout' | 'simulator-error' | 'invalid-output';
  message: string;
}

export type BattleTerminal =
  | { type: 'completed'; result: BattleResult }
  | { type: 'failed'; failure: BattleFailure };

export interface BattleState {
  id: string;
  lifecycle: BattleLifecycle;
  format: SupportedFormat;
  players: readonly BattlePlayer[];
  request?: PlayerRequest;
  result?: BattleResult;
  failure?: BattleFailure;
}

export interface BattleEvent {
  sequence: number;
  scope: 'public' | 'private';
  playerId?: PlayerId;
  kind: 'protocol' | 'result' | 'failure';
  data: string;
}

export interface AcceptedInput {
  playerId: PlayerId;
  revision: number;
  choice: PlayerChoice;
}

export interface BattleReplay {
  battleId: string;
  showdownVersion: string;
  showdownGitHead: string;
  format: SupportedFormat;
  rules: readonly string[];
  seed: string;
  players: readonly BattlePlayer[];
  initialTeams: readonly [string, string];
  acceptedInputs: readonly AcceptedInput[];
  inputLog: readonly string[];
  events: readonly BattleEvent[];
  result: BattleResult;
}
