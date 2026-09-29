import { speciesId } from './showdown-visuals';

export type MoveCategory = 'Physical' | 'Special' | 'Status';

export interface MoveDexEntry {
  type?: string;
  category?: string;
  basePower?: number;
  accuracy?: number | true;
  shortDesc?: string;
  desc?: string;
  pp?: number;
}

export interface EnrichedMove {
  name: string;
  type?: string;
  category?: MoveCategory;
  powerLabel: string;
  accuracyLabel: string;
  ppLabel?: string;
  shortDesc?: string;
}

export interface ParsedCondition {
  hp: number | null;
  maxhp: number | null;
  percent: number | null;
  status: string | null;
  fainted: boolean;
}

const CATEGORIES = new Set<MoveCategory>(['Physical', 'Special', 'Status']);

const STATUS_LABELS: Record<string, string> = {
  par: 'PAR',
  brn: 'BRN',
  psn: 'PSN',
  tox: 'TOX',
  slp: 'SLP',
  frz: 'FRZ',
};

type GlobalMoveDex = {
  BattleMovedex?: Record<string, MoveDexEntry>;
  Dex?: {
    moves?: {
      get?: (name: string) => MoveDexEntry & { exists?: boolean; name?: string };
    };
  };
};

export function moveDexId(name: string): string {
  return speciesId(name);
}

export function lookupMoveDex(
  name: string,
  dex?: Record<string, MoveDexEntry> | null,
): MoveDexEntry | null {
  const id = moveDexId(name);
  if (!id) return null;
  const fromArg = dex?.[id];
  if (fromArg) return fromArg;

  const globals = globalThis as typeof globalThis & GlobalMoveDex;
  const fromGlobal = globals.BattleMovedex?.[id];
  if (fromGlobal) return fromGlobal;

  const fromDex = globals.Dex?.moves?.get?.(name);
  if (fromDex && fromDex.exists !== false && (fromDex.type || fromDex.category)) {
    return fromDex;
  }
  return null;
}

export function enrichMove(
  name: string,
  options: {
    pp?: number;
    maxpp?: number;
    dex?: Record<string, MoveDexEntry> | null;
  } = {},
): EnrichedMove {
  const trimmed = name.trim() || 'Move';
  const entry = lookupMoveDex(trimmed, options.dex);
  const category = CATEGORIES.has(entry?.category as MoveCategory)
    ? entry?.category as MoveCategory
    : undefined;
  const power = entry?.basePower;
  const accuracy = entry?.accuracy;
  const pp = options.pp;
  const maxpp = options.maxpp;
  return {
    name: trimmed,
    type: entry?.type,
    category,
    powerLabel: category === 'Status' || power === 0
      ? '—'
      : typeof power === 'number' && power > 0
        ? String(power)
        : entry
          ? 'Var'
          : '—',
    accuracyLabel: accuracy === true || accuracy == null
      ? (entry ? 'Always' : '—')
      : `${accuracy}%`,
    ppLabel: pp == null || maxpp == null ? undefined : `${pp}/${maxpp} PP`,
    shortDesc: entry?.shortDesc || entry?.desc,
  };
}

export function parsePokemonCondition(condition?: string): ParsedCondition {
  const raw = condition?.trim() ?? '';
  if (!raw) {
    return { hp: null, maxhp: null, percent: null, status: null, fainted: false };
  }
  const fainted = /\bfnt\b/i.test(raw);
  const statusMatch = raw.match(/\b(par|brn|psn|tox|slp|frz)\b/i);
  const hpMatch = raw.match(/^(\d+)(?:\s*\/\s*(\d+))?/);
  const hp = hpMatch ? Number(hpMatch[1]) : null;
  const maxhp = hpMatch?.[2] ? Number(hpMatch[2]) : null;
  const percent = hp != null && maxhp
    ? Math.max(0, Math.min(100, Math.round((hp / maxhp) * 100)))
    : fainted
      ? 0
      : null;
  return {
    hp,
    maxhp,
    percent,
    status: statusMatch ? STATUS_LABELS[statusMatch[1]!.toLowerCase()] ?? statusMatch[1]!.toUpperCase() : null,
    fainted,
  };
}

export function formatSwitchMeta(condition?: string): string {
  const parsed = parsePokemonCondition(condition);
  if (parsed.fainted) return 'Fainted';
  const parts: string[] = [];
  if (parsed.percent != null) parts.push(`${parsed.percent}% HP`);
  else if (parsed.hp != null && parsed.maxhp != null) parts.push(`${parsed.hp}/${parsed.maxhp} HP`);
  if (parsed.status) parts.push(parsed.status);
  return parts.join(' · ') || 'Ready';
}
