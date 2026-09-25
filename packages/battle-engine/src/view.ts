import type {
  BattleFailure,
  BattleLifecycle,
  BattlePlayer,
  BattleResult,
  BattleViewer,
  PlayerId,
  PlayerRequest,
  SupportedFormat,
} from './types';

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
  playerId: PlayerId;
  name: string;
  active?: PokemonView;
}

export interface BattleView {
  battleId: string;
  lifecycle: BattleLifecycle;
  format: SupportedFormat;
  turn: number;
  sides: readonly [SideView, SideView];
  request?: PlayerRequest;
  result?: BattleResult;
  failure?: BattleFailure;
}

interface MutableSide {
  playerId: PlayerId;
  name: string;
  active?: PokemonView;
}

export class BattleViewModel {
  private turn = 0;
  private readonly sides: [MutableSide, MutableSide];
  private readonly nameToSlot = new Map<string, 0 | 1>();

  constructor(players: readonly [BattlePlayer, BattlePlayer]) {
    this.sides = [
      { playerId: players[0].id, name: players[0].name },
      { playerId: players[1].id, name: players[1].name },
    ];
    this.nameToSlot.set(players[0].name, 0);
    this.nameToSlot.set(players[1].name, 1);
  }

  ingestProtocolChunk(chunk: string): void {
    for (const line of chunk.split('\n')) {
      this.ingestLine(line.trim());
    }
  }

  snapshot(
    battleId: string,
    lifecycle: BattleLifecycle,
    format: SupportedFormat,
    viewer: BattleViewer,
    request: PlayerRequest | undefined,
    result: BattleResult | undefined,
    failure: BattleFailure | undefined,
  ): BattleView {
    return {
      battleId,
      lifecycle,
      format,
      turn: this.turn,
      sides: [
        cloneSide(this.sides[0]),
        cloneSide(this.sides[1]),
      ],
      ...(viewer !== 'spectator' && request ? { request } : {}),
      ...(result ? { result } : {}),
      ...(failure ? { failure } : {}),
    };
  }

  private ingestLine(line: string): void {
    if (!line.startsWith('|')) return;
    const parts = line.split('|');
    const kind = parts[1] ?? '';

    switch (kind) {
      case 'player': {
        const slot = parts[2] === 'p2' ? 1 : 0;
        const name = parts[3] ?? this.sides[slot].name;
        this.sides[slot].name = name;
        this.nameToSlot.set(name, slot as 0 | 1);
        break;
      }
      case 'switch':
      case 'drag': {
        const pokemonIdent = parts[2] ?? '';
        const details = parts[3] ?? '';
        const condition = parts[4] ?? '';
        const slot = sideFromIdent(pokemonIdent);
        if (slot === undefined) break;
        const species = speciesFromDetails(details, pokemonIdent);
        const health = parseCondition(condition);
        this.sides[slot].active = {
          species,
          ...(health.level !== undefined ? { level: health.level } : {}),
          ...(health.hp !== undefined ? { hp: health.hp } : {}),
          ...(health.maxHp !== undefined ? { maxHp: health.maxHp } : {}),
          ...(health.hpPercent !== undefined ? { hpPercent: health.hpPercent } : {}),
          ...(health.status ? { status: health.status } : {}),
          fainted: health.fainted,
        };
        break;
      }
      case 'turn': {
        const turn = Number(parts[2]);
        if (Number.isFinite(turn)) this.turn = turn;
        break;
      }
      case '-damage':
      case '-heal':
      case '-sethp': {
        this.applyCondition(parts[2] ?? '', parts[3] ?? '');
        break;
      }
      case '-status': {
        this.applyStatus(parts[2] ?? '', parts[3] ?? '');
        break;
      }
      case '-curestatus': {
        this.clearStatus(parts[2] ?? '');
        break;
      }
      case 'faint': {
        const slot = sideFromIdent(parts[2] ?? '');
        if (slot === undefined || !this.sides[slot].active) break;
        this.sides[slot].active = {
          ...this.sides[slot].active!,
          hp: 0,
          hpPercent: 0,
          fainted: true,
        };
        break;
      }
      default:
        break;
    }
  }

  private applyCondition(ident: string, condition: string): void {
    const slot = sideFromIdent(ident);
    if (slot === undefined || !this.sides[slot].active) return;
    const health = parseCondition(condition);
    this.sides[slot].active = {
      ...this.sides[slot].active!,
      ...(health.hp !== undefined ? { hp: health.hp } : {}),
      ...(health.maxHp !== undefined ? { maxHp: health.maxHp } : {}),
      ...(health.hpPercent !== undefined ? { hpPercent: health.hpPercent } : {}),
      ...(health.status ? { status: health.status } : {}),
      fainted: health.fainted ?? this.sides[slot].active!.fainted,
    };
  }

  private applyStatus(ident: string, status: string): void {
    const slot = sideFromIdent(ident);
    if (slot === undefined || !this.sides[slot].active) return;
    this.sides[slot].active = {
      ...this.sides[slot].active!,
      status,
    };
  }

  private clearStatus(ident: string): void {
    const slot = sideFromIdent(ident);
    if (slot === undefined || !this.sides[slot].active) return;
    const next = { ...this.sides[slot].active! };
    delete next.status;
    this.sides[slot].active = next;
  }
}

function cloneSide(side: MutableSide): SideView {
  return {
    playerId: side.playerId,
    name: side.name,
    ...(side.active ? { active: { ...side.active } } : {}),
  };
}

function sideFromIdent(ident: string): 0 | 1 | undefined {
  if (ident.startsWith('p1')) return 0;
  if (ident.startsWith('p2')) return 1;
  return undefined;
}

function speciesFromDetails(details: string, ident: string): string {
  if (details) {
    const species = details.split(',')[0]?.trim();
    if (species) return species;
  }
  const fromIdent = ident.includes(':') ? ident.split(':').slice(1).join(':').trim() : ident;
  return fromIdent || 'Unknown';
}

function parseCondition(condition: string): {
  hp?: number;
  maxHp?: number;
  hpPercent?: number;
  status?: string;
  fainted?: boolean;
  level?: number;
} {
  if (!condition) return {};
  const [healthPart, statusPart] = condition.split(/\s+/);
  if (healthPart === '0 fnt' || healthPart === '0') {
    return { hp: 0, hpPercent: 0, fainted: true, ...(statusPart ? { status: statusPart } : {}) };
  }
  const ratio = healthPart?.match(/^(\d+)(?:\/(\d+))?$/);
  if (!ratio) {
    return statusPart || healthPart ? { status: statusPart || healthPart } : {};
  }
  const hp = Number(ratio[1]);
  const maxHp = ratio[2] !== undefined ? Number(ratio[2]) : undefined;
  const hpPercent = maxHp && maxHp > 0 ? Math.max(0, Math.min(100, Math.round((hp / maxHp) * 100))) : undefined;
  return {
    hp,
    ...(maxHp !== undefined ? { maxHp } : {}),
    ...(hpPercent !== undefined ? { hpPercent } : {}),
    ...(statusPart ? { status: statusPart } : {}),
    fainted: hp === 0,
  };
}
