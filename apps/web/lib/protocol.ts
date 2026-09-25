export type DemoPlayerId = 'demo-player-1' | 'demo-player-2';

export type PlayerChoice =
  | { type: 'team-preview' }
  | { type: 'move'; slot: number; target?: number; terastallize?: boolean }
  | { type: 'switch'; slot: number }
  | { type: 'pass' };

export interface WalletSnapshot {
  playerId: DemoPlayerId;
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
  reason: 'casual-win' | 'casual-tie' | 'tournament-win' | 'refund';
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

export type ServerMessage =
  | { type: 'ready'; playerId: string; requestId?: string }
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
  | { type: 'match.choice.accepted'; matchId: string; requestId?: string };

export type ClientMessage =
  | { type: 'identify'; playerId: string }
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
  | { type: 'casual.ready'; roomId: string; ready: boolean }
  | { type: 'casual.start'; roomId: string }
  | { type: 'casual.cancel'; roomId: string }
  | { type: 'casual.subscribe'; roomId: string }
  | { type: 'casual.preview'; collateral: number }
  | { type: 'tournament.create'; title?: string; maxPlayers?: 4 | 8 | 16; entryFee?: number }
  | { type: 'tournament.list' }
  | { type: 'tournament.join'; tournamentId: string }
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
  | { type: 'ping' };
