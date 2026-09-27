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
  symbol: 'POKE';
  mocked: true;
  winnerId?: string;
  amount: number;
  protocolFee?: number;
  reason: 'casual-win' | 'casual-forfeit' | 'casual-tie' | 'tournament-win' | 'refund';
}

export interface CasualRoom {
  id: string;
  matchId: string;
  roomType: 'private' | 'open';
  battleSize: '1v1' | '2v2';
  format: 'gen9ou';
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
}

export interface TournamentSummary {
  id: string;
  title: string;
  format: string;
  maxPlayers: number;
  status: string;
  playerCount: number;
  entryFee: number;
  economics: TournamentEconomicsPreview;
  winner?: string;
}

export interface ArenaSnapshot {
  wallet: WalletSnapshot;
  tournaments: TournamentSummary[];
  openCasualRooms: CasualRoom[];
  myCasualRooms: CasualRoom[];
  recentCasualResults: CasualRoom[];
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
  | { type: 'casual.created'; room: CasualRoom; requestId?: string }
  | { type: 'casual.list'; rooms: CasualRoom[]; recentResults: CasualRoom[]; requestId?: string }
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
  | {
      type: 'casual.create';
      roomType: 'private' | 'open';
      battleSize: '1v1' | '2v2';
      collateral: number;
      invitedPlayerId?: string;
    }
  | { type: 'casual.list' }
  | { type: 'casual.accept'; roomId: string }
  | { type: 'casual.ready'; roomId: string; ready: boolean; team?: string }
  | { type: 'casual.start'; roomId: string; team?: string }
  | { type: 'casual.cancel'; roomId: string }
  | { type: 'casual.forfeit'; roomId: string }
  | { type: 'casual.subscribe'; roomId: string }
  | { type: 'casual.preview'; collateral: number }
  | { type: 'tournament.create'; title?: string; maxPlayers?: 4 | 8 | 16 | 32; entryFee?: number }
  | { type: 'tournament.list' }
  | { type: 'tournament.join'; tournamentId: string; team?: string }
  | { type: 'tournament.start'; tournamentId: string }
  | { type: 'tournament.subscribe'; tournamentId: string }
  | { type: 'match.subscribe'; matchId: string }
  | {
      type: 'match.choice';
      matchId: string;
      battleInstanceId: string;
      requestRevision: number;
      choice: PlayerChoice;
    }
  | { type: 'ping' }
  | { type: 'team.starter' }
  | { type: 'team.inspect'; team: string }
  | {
      type: 'team.search';
      kind: 'species' | 'move' | 'item' | 'ability';
      query: string;
      species?: string;
    };
