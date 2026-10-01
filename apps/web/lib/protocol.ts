export type DemoPlayerId = 'demo-player-1' | 'demo-player-2';
export type PlayerId = string;

export type PlayerChoice =
  | { type: 'team-preview' }
  | { type: 'move'; slot: number; target?: number; terastallize?: boolean }
  | { type: 'switch'; slot: number }
  | { type: 'pass' };

export interface WalletSnapshot {
  playerId: PlayerId;
  symbol: 'POKE';
  balance: number;
  eligible: boolean;
}

export interface CasualEconomicsPreview {
  symbol: 'POKE';
  collateral: number;
  totalPot: number;
  protocolFee: number;
  feeRateBps: number;
  winnerPayout: number;
}

export interface TournamentEconomicsPreview {
  symbol: 'POKE';
  entryFee: number;
  playerCount: number;
  totalEntries: number;
  treasuryShare: number;
  treasuryBps: number;
  devOpsShare: number;
  devOpsBps: number;
  prizePool: number;
}

export interface MockPayoutResult {
  symbol: 'POKE' | 'SOL';
  mocked?: true;
  winnerId?: string;
  amount: number;
  protocolFee?: number;
  reason: 'casual-win' | 'casual-forfeit' | 'casual-tie' | 'tournament-win' | 'refund';
}

export interface CasualPreviewMon {
  slot: number;
  species: string;
  item: string;
  ability: string;
  nature: string;
  moves: string[];
  types: string[];
}

export interface CasualTeamPreview {
  playerId: string;
  presetId: string;
  presetName: string;
  pokemon: CasualPreviewMon[];
  confirmed: boolean;
  selectedSlots?: number[];
}

export type CasualRuleset = 'casual' | 'competitive';

export function formatCasualRoomLabel(room: {
  ruleset?: CasualRuleset;
  battleSize: '1v1' | '2v2';
}): string {
  if (room.ruleset === 'competitive') return 'Competitive · Gen 9 OU';
  return room.battleSize === '1v1' ? 'Casual 6 → 3' : 'GEN 9 OU';
}

export interface CasualRoom {
  id: string;
  matchId: string;
  roomType: 'private' | 'open';
  battleSize: '1v1' | '2v2';
  format: 'gen9ou';
  ruleset?: CasualRuleset;
  creatorId: string;
  opponentId?: string;
  invitedPlayerId?: string;
  collateral: number;
  economics: CasualEconomicsPreview;
  status: string;
  ready: Record<string, boolean>;
  battleInstanceId?: string;
  winnerId?: string;
  rosters?: {
    playerId: string;
    pokemon: { species: string; fainted: boolean }[];
  }[];
  payout?: MockPayoutResult;
  rail?: 'legacy_poke' | 'sol_chain';
  deposits?: { creator?: boolean; opponent?: boolean };
  teamPreview?: CasualTeamPreview[];
  countdownEndsAt?: number;
  selectionEndsAt?: number;
}

export interface TournamentSummary {
  id: string;
  title: string;
  format: string;
  ruleset?: string;
  createdAt?: number;
  finalizesAt?: number;
  maxPlayers: number;
  status: string;
  playerCount: number;
  entryFee: number;
  economics: TournamentEconomicsPreview;
  winner?: string;
}

export interface PassportSnapshot {
  eligible: boolean;
  liquidAtoms: string;
  heldEntryAtoms: string;
  qualifyingAtoms: string;
  usdCents: number;
  thresholdUsdCents: number;
  reason: string;
  shortfallAtoms: string;
  atomsForEntryAndPassport: string;
  quote: {
    priceMicroUsd: number;
    decimals: number;
    observedAt: number;
    source: string;
    confidenceBps: number;
    quoteId: string;
  };
}

export interface TxIntentPayload {
  intentId: string;
  serializedTx?: number[];
  kind?: string;
  entryAtoms?: string;
  economics?: unknown;
  passport?: PassportSnapshot;
  quote?: PassportSnapshot['quote'];
  burnKeys?: string[];
  instructionCount?: number;
}

export interface PublicTrainerProfile {
  username: string;
  spriteId: string;
}

export interface ArenaSnapshot {
  wallet: WalletSnapshot;
  tournaments: TournamentSummary[];
  openCasualRooms: CasualRoom[];
  myCasualRooms: CasualRoom[];
  recentCasualResults: CasualRoom[];
  chainEconomyEnabled?: boolean;
  passport?: PassportSnapshot;
  solBalances?: { freeLamports: string; treasuryLamports: string };
  trainers?: Record<string, PublicTrainerProfile>;
}

export interface PokemonView {
  species: string;
  level?: number;
  hp?: number;
  maxHp?: number;
  hpPercent?: number;
  status?: string;
  fainted?: boolean;
}

export interface SideView {
  playerId: string;
  name: string;
  active?: PokemonView;
  party?: PokemonView[];
}

export interface AvailableChoice {
  type: 'team-preview' | 'move' | 'switch' | 'pass';
  slot?: number;
  terastallize?: boolean;
}

export interface PlayerRequest {
  playerId: string;
  revision: number;
  kind: string;
  choices: AvailableChoice[];
}

export interface BattleView {
  battleId: string;
  lifecycle: string;
  format: string;
  turn: number;
  sides: [SideView, SideView];
  request?: PlayerRequest;
  result?: {
    status: 'win' | 'tie';
    winner?: string;
    score: number[];
    turns: number;
  };
  failure?: {
    code: string;
    message: string;
  };
}

export interface MatchPayload {
  id: string;
  status: string;
  player1?: string;
  player2?: string;
  tournamentId?: string;
  battleInstanceId?: string;
  winner?: string;
  roomId?: string;
  round?: number;
  bracketPosition?: number;
}

export interface LiveFight {
  matchId: string;
  source: 'tournament' | 'casual';
  title: string;
  player1: string;
  player2?: string;
  format: string;
  battleSize?: '1v1' | '2v2';
  roomId?: string;
  tournamentId?: string;
  status: string;
}

export interface TeamSearchHit {
  name: string;
  description?: string;
  type?: string;
  types?: string[];
  category?: string;
  power?: number;
  accuracy?: number | null;
  pp?: number;
}

export interface FightHistoryEntry {
  id: string;
  matchId: string;
  mode: 'casual' | 'competitive' | 'tournament';
  opponentId: string;
  result: 'win' | 'loss' | 'tie' | 'forfeit';
  completedAt: number;
  symbol: 'POKE' | 'SOL';
  stake: number;
  payout: number;
  fee: number;
  net: number;
  paid: boolean;
  detailPath: string;
}

export interface FightHistoryCursor {
  completedAt: number;
  id: string;
}

export type ServerMessage =
  | { type: 'ready'; playerId: string; requestId?: string }
  | {
      type: 'auth.challenge';
      address: string;
      nonce: string;
      message: string;
      expiresAt: number;
      requestId?: string;
    }
  | { type: 'auth.verified'; playerId: string; requestId?: string }
  | { type: 'error'; code: string; message: string; requestId?: string }
  | { type: 'pong'; requestId?: string }
  | { type: 'arena.snapshot'; snapshot: ArenaSnapshot; requestId?: string }
  | {
      type: 'passport.status';
      passport: PassportSnapshot;
      chainEconomyEnabled: boolean;
      requestId?: string;
    }
  | {
      type: 'treasury.snapshot';
      deposits: Array<{
        claimKey: string;
        source: string;
        grossLamports: number;
        treasuryLamports: number;
        operatorLamports: number;
        signature?: string;
        createdAt: string;
      }>;
      chainEconomyEnabled: boolean;
      requestId?: string;
    }
  | { type: 'tx.intent'; intent: TxIntentPayload; requestId?: string }
  | {
      type: 'tx.update';
      intentId: string;
      status: string;
      signature?: string;
      error?: string;
      requestId?: string;
    }
  | { type: 'casual.created'; room: CasualRoom; intent?: TxIntentPayload; requestId?: string }
  | { type: 'casual.list'; rooms: CasualRoom[]; recentResults: CasualRoom[]; requestId?: string }
  | { type: 'history.list'; entries: FightHistoryEntry[]; nextCursor?: FightHistoryCursor; requestId?: string }
  | { type: 'casual.state'; room: CasualRoom; requestId?: string }
  | { type: 'casual.preview'; economics: CasualEconomicsPreview; requestId?: string }
  | { type: 'casual.result'; room: CasualRoom; payout?: MockPayoutResult; requestId?: string }
  | { type: 'tournament.created'; tournament: any; requestId?: string }
  | { type: 'tournament.list'; tournaments: TournamentSummary[]; requestId?: string }
  | { type: 'tournament.state'; tournament: any; requestId?: string }
  | { type: 'tournament.result'; tournament: any; payout?: MockPayoutResult; requestId?: string }
  | {
      type: 'match.update' | 'match.subscribed';
      match: MatchPayload;
      state: any;
      events: any[];
      view?: BattleView;
      source: 'tournament' | 'casual';
      requestId?: string;
    }
  | { type: 'match.choice.accepted'; matchId: string; requestId?: string }
  | { type: 'live.list'; fights: LiveFight[]; requestId?: string }
  | { type: 'live.update'; fight?: LiveFight; view?: BattleView; events?: unknown[]; requestId?: string }
  | { type: 'trainer.directory'; trainers: Record<string, PublicTrainerProfile>; requestId?: string }
  | { type: 'trainer.profile'; playerId: string; profile: PublicTrainerProfile; requestId?: string }
  | { type: 'team.starter'; name: string; paste: string; requestId?: string }
  | { type: 'team.inspect'; inspection: import('./team').TeamInspection; requestId?: string }
  | {
      type: 'team.search';
      results: string[];
      hits?: TeamSearchHit[];
      scoped?: boolean;
      requestId?: string;
    };

export type ClientMessage =
  | { type: 'identify'; playerId: string }
  | { type: 'auth.challenge'; address: string }
  | { type: 'auth.verify'; address: string; signature: string; nonce: string }
  | { type: 'arena.snapshot' }
  | { type: 'passport.status' }
  | { type: 'treasury.snapshot' }
  | { type: 'tx.confirm'; intentId: string; signature: string }
  | {
      type: 'casual.create';
      roomType: 'private' | 'open';
      battleSize: '1v1' | '2v2';
      collateral: number;
      collateralLamports?: number;
      invitedPlayerId?: string;
      ruleset?: CasualRuleset;
      stake?: 'mock' | 'real';
    }
  | { type: 'casual.list' }
  | { type: 'history.list'; limit?: number; beforeCompletedAt?: number; beforeId?: string }
  | { type: 'casual.accept'; roomId: string }
  | { type: 'casual.stake'; roomId: string }
  | { type: 'casual.ready'; roomId: string; ready: boolean; team?: string }
  | { type: 'casual.select'; roomId: string; slots: number[]; confirm?: boolean }
  | { type: 'casual.start'; roomId: string; team?: string }
  | { type: 'casual.cancel'; roomId: string }
  | { type: 'casual.forfeit'; roomId: string }
  | { type: 'casual.subscribe'; roomId: string }
  | { type: 'casual.preview'; collateral: number; stake?: 'mock' | 'real' }
  | { type: 'tournament.create'; title?: string; maxPlayers?: 4 | 8 | 16 | 32; entryFee?: number; ruleset?: string }
  | { type: 'tournament.list' }
  | { type: 'tournament.join'; tournamentId: string; team?: string; slots?: number[]; playerPokeAta?: string }
  | { type: 'tournament.updateTeam'; tournamentId: string; team: string }
  | { type: 'tournament.lockTeam'; tournamentId: string }
  | { type: 'tournament.leave'; tournamentId: string }
  | { type: 'tournament.start'; tournamentId: string }
  | { type: 'tournament.subscribe'; tournamentId: string }
  | { type: 'match.subscribe'; matchId: string }
  | { type: 'live.list' }
  | { type: 'live.watch'; matchId?: string }
  | { type: 'live.unwatch' }
  | { type: 'trainer.profile'; username: string; spriteId: string }
  | {
      type: 'match.choice';
      matchId: string;
      battleInstanceId: string;
      requestRevision: number;
      choice: PlayerChoice;
    }
  | { type: 'ping' }
  | { type: 'team.starter' }
  | { type: 'team.inspect'; team: string; ruleset?: string }
  | {
      type: 'team.search';
      kind: 'species' | 'move' | 'item' | 'ability';
      query: string;
      species?: string;
      ruleset?: string;
    };
