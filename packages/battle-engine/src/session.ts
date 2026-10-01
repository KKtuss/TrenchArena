import { getPlayerStreams } from 'pokemon-showdown';

import {
  BattleEngineError,
  BattleTimeoutError,
  InvalidChoiceError,
  InvalidLifecycleTransitionError,
  StaleChoiceError,
  UnknownPlayerError,
  WrongBattleError,
} from './errors';
import {
  choiceToCommand,
  normalizeRequest,
  parseChoiceRequests,
} from './requests';
import {
  SHOWDOWN_GIT_HEAD,
  SHOWDOWN_VERSION,
  teamSpeciesList,
} from './teams';
import { RecordingBattleStream, type ShowdownTerminalData } from './showdown-stream';
import { BattleViewModel, type BattleView } from './view';
import type {
  AcceptedInput,
  BattleEvent,
  BattleFailure,
  BattlePlayer,
  BattleReplay,
  BattleResult,
  BattleState,
  BattleTerminal,
  BattleViewer,
  ChoiceSubmission,
  PlayerChoice,
  PlayerId,
  PlayerRequest,
  SupportedFormat,
} from './types';

type PlayerSlot = 'p1' | 'p2';
type RoutedStreams = ReturnType<typeof getPlayerStreams>;

export interface BattleSessionSetup {
  id: string;
  format: SupportedFormat;
  showdownFormatId?: string;
  rules: readonly string[];
  seed: string;
  players: readonly [BattlePlayer, BattlePlayer];
  initialTeams: readonly [string, string];
  timeoutMs: number;
}

export class BattleSession {
  readonly id: string;
  readonly format: SupportedFormat;
  readonly seed: string;
  readonly players: readonly [BattlePlayer, BattlePlayer];

  private readonly rules: readonly string[];
  private readonly showdownFormatId: string;
  private readonly initialTeams: readonly [string, string];
  private readonly timeoutMs: number;
  private readonly playerSlots = new Map<PlayerId, PlayerSlot>();
  private readonly playerByName = new Map<string, PlayerId>();
  private readonly pendingRequests = new Map<PlayerId, PlayerRequest>();
  private readonly revisions = new Map<PlayerId, number>();
  private readonly acceptedInputs: AcceptedInput[] = [];
  private readonly events: BattleEvent[] = [];
  private readonly viewModel: BattleViewModel;
  private lifecycle: BattleState['lifecycle'] = 'created';
  private result: BattleResult | undefined;
  private failure: BattleFailure | undefined;
  private stream: RecordingBattleStream | undefined;
  private routed: RoutedStreams | undefined;
  private inputLog: string[] | undefined;
  private timeout: NodeJS.Timeout | undefined;
  private sequence = 0;
  private readySettled = false;
  private readonly ready: Promise<void>;
  private readonly terminalListeners = new Set<(terminal: BattleTerminal) => void>();
  private readonly eventListeners = new Set<(event: BattleEvent) => void>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(setup: BattleSessionSetup) {
    this.id = setup.id;
    this.format = setup.format;
    this.seed = setup.seed;
    this.players = setup.players;
    this.rules = setup.rules;
    this.showdownFormatId = setup.showdownFormatId ?? setup.format;
    this.initialTeams = setup.initialTeams;
    this.timeoutMs = setup.timeoutMs;

    for (const [index, player] of setup.players.entries()) {
      this.playerSlots.set(player.id, index === 0 ? 'p1' : 'p2');
      this.playerByName.set(player.name, player.id);
      this.revisions.set(player.id, 0);
    }

    this.viewModel = new BattleViewModel(setup.players, [
      teamSpeciesList(setup.initialTeams[0] ?? ''),
      teamSpeciesList(setup.initialTeams[1] ?? ''),
    ]);

    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async start(): Promise<void> {
    this.assertLifecycle('start', ['created']);

    this.lifecycle = 'started';
    this.stream = new RecordingBattleStream();
    this.streamTerminal();
    this.routed = getPlayerStreams(this.stream);

    void this.collectPublicEvents(this.routed.spectator);
    for (const player of this.players) {
      void this.collectPlayerEvents(player.id, this.routed[this.playerSlots.get(player.id)!]);
    }

    this.armDecisionTimer();

    try {
      await this.stream.write(this.startCommand());
      await this.ready;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), 'simulator-error');
      throw error;
    }
  }

  getState(viewer: BattleViewer = 'spectator'): BattleState {
    this.assertViewer(viewer);
    const request = viewer === 'spectator'
      ? undefined
      : this.pendingRequests.get(viewer);

    return {
      id: this.id,
      lifecycle: this.lifecycle,
      format: this.format,
      players: this.players,
      ...(request ? { request } : {}),
      ...(this.result ? { result: this.result } : {}),
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  getEvents(viewer: BattleViewer = 'spectator'): readonly BattleEvent[] {
    this.assertViewer(viewer);
    return this.events.filter(event => (
      event.scope === 'public' || event.playerId === viewer
    ));
  }

  getView(viewer: BattleViewer = 'spectator'): BattleView {
    this.assertViewer(viewer);
    const request = viewer === 'spectator'
      ? undefined
      : this.pendingRequests.get(viewer);
    return this.viewModel.snapshot(
      this.id,
      this.lifecycle,
      this.format,
      viewer,
      request,
      this.result,
      this.failure,
    );
  }

  getResult(): BattleResult | undefined {
    return this.result;
  }

  /** Players who currently owe a decision. Wait requests are not inactivity. */
  actionablePendingPlayerIds(): PlayerId[] {
    return [...this.pendingRequests.entries()]
      .filter(([, request]) => request.kind !== 'wait')
      .map(([playerId]) => playerId);
  }

  subscribe(listener: (terminal: BattleTerminal) => void): () => void {
    if (this.result) {
      queueMicrotask(() => listener({ type: 'completed', result: this.result! }));
      return () => undefined;
    }
    if (this.failure) {
      queueMicrotask(() => listener({ type: 'failed', failure: this.failure! }));
      return () => undefined;
    }

    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  subscribeEvents(listener: (event: BattleEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Returns the already-finalized result. Repeated calls are intentionally
   * idempotent and never recalculate the winner.
   */
  finalize(): BattleResult | undefined {
    return this.result;
  }

  async submitChoice(submission: ChoiceSubmission): Promise<void> {
    if (submission.battleId !== this.id) {
      throw new WrongBattleError(submission.battleId);
    }
    this.assertLifecycle('submit a choice', ['started', 'awaiting-choice']);
    this.assertViewer(submission.playerId);

    const request = this.pendingRequests.get(submission.playerId);
    if (!request || request.revision !== submission.revision) {
      throw new StaleChoiceError(submission.playerId, submission.revision);
    }

    const command = choiceToCommand(request, submission.choice);
    this.pendingRequests.delete(submission.playerId);
    if (this.actionablePendingPlayerIds().length === 0) {
      this.disarmDecisionTimer();
    }
    this.acceptedInputs.push({
      playerId: submission.playerId,
      revision: submission.revision,
      choice: submission.choice,
    });

    try {
      await this.routed![this.playerSlots.get(submission.playerId)!].write(command);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), 'simulator-error');
      throw error;
    }
  }

  /**
   * The named player concedes. Showdown awards the win to the opponent and
   * the normal terminal path settles the fight.
   */
  async forfeit(playerId: PlayerId): Promise<void> {
    this.assertLifecycle('forfeit', ['started', 'awaiting-choice']);
    this.assertViewer(playerId);
    const slot = this.playerSlots.get(playerId);
    if (!slot || !this.routed) {
      throw new BattleEngineError('Battle is not ready to forfeit.');
    }
    await this.routed.omniscient.write(`>forcelose ${slot}\n`);
  }

  getReplay(): BattleReplay {
    if (this.lifecycle !== 'ended' || !this.result || !this.inputLog) {
      throw new InvalidLifecycleTransitionError(this.lifecycle, 'export a replay');
    }

    return {
      battleId: this.id,
      showdownVersion: SHOWDOWN_VERSION,
      showdownGitHead: SHOWDOWN_GIT_HEAD,
      format: this.format,
      rules: this.rules,
      seed: this.seed,
      players: this.players,
      initialTeams: this.initialTeams,
      acceptedInputs: this.acceptedInputs.slice(),
      inputLog: this.inputLog.slice(),
      events: this.events.slice(),
      result: this.result,
    };
  }

  private streamTerminal(): void {
    this.stream!.terminal.then(
      data => this.handleTerminal(data),
      error => this.fail(error, 'invalid-output'),
    );
  }

  private async collectPublicEvents(stream: AsyncIterable<string>): Promise<void> {
    try {
      for await (const chunk of stream) {
        this.appendEvent({ scope: 'public', kind: 'protocol', data: chunk });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), 'simulator-error');
    }
  }

  private async collectPlayerEvents(
    playerId: PlayerId,
    stream: AsyncIterable<string>,
  ): Promise<void> {
    try {
      for await (const chunk of stream) {
        const requests = parseChoiceRequests(chunk);
        if (requests.length) {
          this.appendEvent({
            scope: 'private',
            playerId,
            kind: 'protocol',
            data: chunk,
          });
          for (const request of requests) this.acceptRequest(playerId, request);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), 'invalid-output');
    }
  }

  private acceptRequest(playerId: PlayerId, request: Parameters<typeof normalizeRequest>[2]): void {
    const revision = (this.revisions.get(playerId) ?? 0) + 1;
    this.revisions.set(playerId, revision);
    const normalized = normalizeRequest(playerId, revision, request);
    this.pendingRequests.set(playerId, normalized);
    this.lifecycle = 'awaiting-choice';
    if (normalized.kind !== 'wait') {
      // Every new decision request starts a fresh window. A clock armed at
      // battle start cannot still be running on a later turn.
      this.armDecisionTimer();
    } else if (this.actionablePendingPlayerIds().length === 0) {
      this.disarmDecisionTimer();
    }

    if (this.pendingRequests.size === this.players.length) {
      this.resolveReadyOnce();
    }
  }

  private handleTerminal(data: ShowdownTerminalData): void {
    if (this.result || this.failure) return;

    try {
      const result = normalizeResult(data, this.playerByName);
      this.result = result;
      this.inputLog = normalizeInputLog(data);
      this.pendingRequests.clear();
      this.lifecycle = 'ended';
      this.disarmDecisionTimer();
      this.appendEvent({
        scope: 'public',
        kind: 'result',
        data: JSON.stringify(result),
      });
      this.notifyTerminal({ type: 'completed', result });
      this.eventListeners.clear();
      this.resolveReadyOnce();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)), 'invalid-output');
    }
  }

  /**
   * Inactivity deadline for the current decision, not a clock from battle
   * start. Each actionable request arms a fresh window, and the window is
   * cleared once nobody still owes a move. Firing with nobody pending is not
   * a result: the turn is resolving, or the fight has not gone live.
   */
  private expireByTimeout(): void {
    this.timeout = undefined;
    if (this.result || this.failure || this.lifecycle === 'ended' || this.lifecycle === 'failed') {
      return;
    }

    const inactive = this.actionablePendingPlayerIds();
    if (inactive.length === 1) {
      const loser = inactive[0];
      const winner = this.players.find(player => player.id !== loser);
      if (winner) {
        this.finishWithResult({
          status: 'win',
          winner: winner.id,
          score: this.viewModel.remainingPokemon(),
          turns: this.viewModel.currentTurn(),
          endedBy: 'timeout',
        });
        return;
      }
    }

    if (inactive.length >= 2) {
      this.finishWithResult({
        status: 'tie',
        score: this.viewModel.remainingPokemon(),
        turns: this.viewModel.currentTurn(),
        endedBy: 'timeout',
      });
      return;
    }

    if (this.lifecycle !== 'awaiting-choice') {
      this.fail(new BattleTimeoutError(this.timeoutMs), 'timeout');
    }
  }

  private armDecisionTimer(): void {
    this.disarmDecisionTimer();
    this.timeout = setTimeout(() => this.expireByTimeout(), this.timeoutMs);
  }

  private disarmDecisionTimer(): void {
    if (!this.timeout) return;
    clearTimeout(this.timeout);
    this.timeout = undefined;
  }

  private finishWithResult(result: BattleResult): void {
    if (this.result || this.failure) return;
    this.result = result;
    this.pendingRequests.clear();
    this.lifecycle = 'ended';
    this.disarmDecisionTimer();
    this.appendEvent({
      scope: 'public',
      kind: 'result',
      data: JSON.stringify(result),
    });
    this.notifyTerminal({ type: 'completed', result });
    this.eventListeners.clear();
    this.resolveReadyOnce();
    if (this.stream && !this.stream.atEOF) {
      void this.stream.writeEnd().catch(() => undefined);
    }
  }

  private fail(error: Error, code: BattleFailure['code']): void {
    if (this.lifecycle === 'ended' || this.lifecycle === 'failed') return;

    this.lifecycle = 'failed';
    this.pendingRequests.clear();
    this.failure = { code, message: error.message };
    this.disarmDecisionTimer();
    this.appendEvent({
      scope: 'public',
      kind: 'failure',
      data: error.message,
    });
    this.notifyTerminal({ type: 'failed', failure: this.failure });
    this.eventListeners.clear();
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    if (this.stream && !this.stream.atEOF) {
      void this.stream.writeEnd().catch(() => undefined);
    }
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private notifyTerminal(terminal: BattleTerminal): void {
    for (const listener of this.terminalListeners) {
      queueMicrotask(() => {
        try {
          listener(terminal);
        } catch {
          // Terminal observers must not corrupt the authoritative session result.
        }
      });
    }
    this.terminalListeners.clear();
  }

  private appendEvent(event: Omit<BattleEvent, 'sequence'>): void {
    const recorded = { sequence: ++this.sequence, ...event };
    this.events.push(recorded);
    if (recorded.scope === 'public' && recorded.kind === 'protocol') {
      this.viewModel.ingestProtocolChunk(recorded.data);
    }
    for (const listener of this.eventListeners) {
      queueMicrotask(() => {
        try {
          listener(recorded);
        } catch {
          // Event observers must not corrupt the authoritative session state.
        }
      });
    }
  }

  private assertLifecycle(action: string, allowed: BattleState['lifecycle'][]): void {
    if (!allowed.includes(this.lifecycle)) {
      throw new InvalidLifecycleTransitionError(this.lifecycle, action);
    }
  }

  private assertViewer(viewer: BattleViewer): void {
    if (viewer !== 'spectator' && !this.playerSlots.has(viewer)) {
      throw new UnknownPlayerError(viewer);
    }
  }

  private startCommand(): string {
    const [p1, p2] = this.players;
    const [team1, team2] = this.initialTeams;
    return [
      `>start ${JSON.stringify({ formatid: this.showdownFormatId, seed: this.seed })}`,
      `>player p1 ${JSON.stringify({ name: p1.name, team: team1 })}`,
      `>player p2 ${JSON.stringify({ name: p2.name, team: team2 })}`,
    ].join('\n');
  }
}

function normalizeResult(
  data: ShowdownTerminalData,
  playerByName: ReadonlyMap<string, PlayerId>,
): BattleResult {
  if (
    !Array.isArray(data.score) ||
    !data.score.every(item => typeof item === 'number') ||
    typeof data.turns !== 'number'
  ) {
    throw new Error('Showdown terminal output has an invalid score or turn count.');
  }

  if (data.winner !== undefined && typeof data.winner !== 'string') {
    throw new Error('Showdown terminal output has an invalid winner.');
  }

  const winnerName = data.winner ?? '';
  const winner = winnerName ? playerByName.get(winnerName) : undefined;
  if (winnerName && !winner) {
    throw new Error(`Showdown returned an unknown winner: ${winnerName}`);
  }

  return {
    status: winner ? 'win' : 'tie',
    ...(winner ? { winner } : {}),
    score: data.score,
    turns: data.turns,
  };
}

function normalizeInputLog(data: ShowdownTerminalData): string[] {
  if (!Array.isArray(data.inputLog) || !data.inputLog.every(item => typeof item === 'string')) {
    throw new Error('Showdown terminal output did not contain an input log.');
  }
  return data.inputLog;
}
