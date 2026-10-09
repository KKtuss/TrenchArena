import type { CasualRoom } from '@/lib/protocol';

export type ArenaAccent = 'casual' | 'ou';

/** Matches the tournament accents: casual violet, competitive Gen 9 OU cyan. */
export function roomAccent(room: Pick<CasualRoom, 'ruleset'>): ArenaAccent {
  return room.ruleset === 'competitive' ? 'ou' : 'casual';
}

export function roomStatusTone(status: string): string {
  if (status === 'open') return 'is-open';
  if (status === 'battling' || status === 'starting') return 'is-live';
  if (status === 'drafting' || status === 'pending_deposit') return 'is-warn';
  if (status === 'full' || status === 'ready') return 'is-info';
  return 'is-done';
}

export function roomStatusPulses(status: string): boolean {
  return status === 'open' || status === 'battling' || status === 'starting';
}

export function roomStatusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

export function roomCode(room: Pick<CasualRoom, 'id'>): string {
  return room.id.slice(0, 8).toUpperCase();
}
