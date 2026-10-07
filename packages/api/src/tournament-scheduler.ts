import {
  TOURNAMENT_SCHEDULE_INTERVAL_MS,
  type TournamentSchedulerState,
  type TournamentSchedulerStore,
} from '@pokearena/db';
import {
  tournamentRotationEvent,
  type TournamentRotationDefinition,
  type TournamentService,
} from '@pokearena/tournament';

export interface TournamentSchedulerOptions {
  store: TournamentSchedulerStore;
  tournaments: TournamentService;
  now?: () => number;
  pollMs?: number;
  createTournament?: (
    definition: TournamentRotationDefinition,
    scheduledKey: string,
  ) => Promise<void>;
}

/**
 * One-shot, persisted scheduler. The poller is only a wake-up mechanism; the
 * deadline and the cross-process lock live in TournamentSchedulerStore.
 */
export class TournamentScheduler {
  private readonly store: TournamentSchedulerStore;
  private readonly tournaments: TournamentService;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly createTournament: (
    definition: TournamentRotationDefinition,
    scheduledKey: string,
  ) => Promise<void>;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: TournamentSchedulerOptions) {
    this.store = options.store;
    this.tournaments = options.tournaments;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 1_000;
    this.createTournament = options.createTournament ?? (async (definition, scheduledKey) => {
      const tournament = await this.tournaments.createTournament({
        title: definition.title,
        format: 'gen9ou',
        ruleset: definition.id,
        maxPlayers: definition.maxPlayers,
        hostId: 'scheduler',
        entryFee: 0,
        scheduledKey,
      });
      await this.tournaments.openRegistration(tournament.id);
    });
  }

  async state(): Promise<TournamentSchedulerState> {
    return this.store.getState();
  }

  async activate(now = this.now()): Promise<TournamentSchedulerState> {
    return this.store.activate(now);
  }

  async disable(): Promise<TournamentSchedulerState> {
    return this.store.disable();
  }

  async tick(now = this.now()): Promise<boolean> {
    const created = await this.store.runDueStart(now, async state => {
      const scheduledKey = scheduledStartKey(state);
      const existing = (await this.tournaments.listTournaments())
        .find(tournament => tournament.scheduledKey === scheduledKey);
      if (existing) {
        if (existing.status === 'draft') {
          await this.tournaments.openRegistration(existing.id);
        }
        return false;
      }
      await this.createTournament(
        tournamentRotationEvent(state.nextRotationIndex),
        scheduledKey,
      );
      return true;
    });
    return created ?? false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function scheduledStartKey(state: TournamentSchedulerState): string {
  if (state.nextTournamentStartAt === undefined) {
    throw new Error('A scheduled start has no persisted deadline.');
  }
  return `tournament-schedule:${state.nextTournamentStartAt}:${state.nextRotationIndex}`;
}

export { TOURNAMENT_SCHEDULE_INTERVAL_MS };
