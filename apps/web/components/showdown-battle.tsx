'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { useDeltaPulse } from '@/components/motion';
import { ProfileTrainerSprite } from '@/components/profile-trainer';
import { PokemonIcon, PokemonSprite, TypeMark } from '@/components/showdown-visuals';
import { hpScale } from '@/lib/motion';
import { acquireShowdownRuntime, releaseShowdownRuntime } from '@/lib/showdown-runtime';
import type { ArenaApiClient } from '@/lib/api-client';
import { useArena } from '@/lib/arena-context';
import {
  eventsToShowdownFeed,
  latestRequestPayload,
  shouldCatchUpShowdownFeed,
  showdownChoiceToPlayerChoice,
} from '@/lib/showdown-client-adapter';
import {
  enrichMove,
  formatSwitchMeta,
  parsePokemonCondition,
  type EnrichedMove,
} from '@/lib/fight-moves';
import type { BattleView, PlayerChoice, SideView } from '@/lib/protocol';
import { publicTrainerName } from '@/lib/trainer-profile';

declare global {
  interface Window {
    Battle?: new (options: {
      id: string;
      $frame: unknown;
      $logFrame: unknown;
      log: string[];
      paused: boolean;
      autoresize: boolean;
    }) => ShowdownBattle;
    BattleChoiceBuilder?: {
      new (request: ShowdownRequest): unknown;
      fixRequest?: (request: ShowdownRequest, battle: ShowdownBattle) => void;
    };
    jQuery?: (element: HTMLElement) => unknown;
    $?: (element: HTMLElement) => unknown;
    Config?: unknown;
    [key: string]: unknown;
  }
}

interface ShowdownBattle {
  add: (line: string) => void;
  destroy: () => void;
  setViewpoint: (sideid: string) => void;
  seekTurn: (turn: number, forceReset?: boolean) => void;
  play: () => void;
  paused: boolean;
  atQueueEnd: boolean;
  subscription?: ((state: string) => void) | null;
  scene?: { log?: { battleParser?: { perspective: string } } };
}

interface ShowdownMove {
  name: string;
  pp?: number;
  maxpp?: number;
  disabled?: boolean;
}

interface ShowdownRequest {
  requestType?: 'move' | 'switch' | 'team' | 'wait';
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: boolean[];
  active?: Array<{
    moves?: ShowdownMove[];
    canTerastallize?: string;
    trapped?: boolean;
  } | null>;
  side?: {
    pokemon?: Array<{
      ident?: string;
      details?: string;
      condition?: string;
      active?: boolean;
    }>;
  };
  rqid?: number;
}

const SHOWDOWN_BATTLE_BACKGROUNDS = [
  'bg-beach',
  'bg-beachshore',
  'bg-city',
  'bg-dampcave',
  'bg-deepsea',
  'bg-desert',
  'bg-earthycave',
  'bg-forest',
  'bg-icecave',
  'bg-meadow',
  'bg-mountain',
  'bg-river',
  'bg-route',
  'bg-thunderplains',
  'bg-volcanocave',
] as const;

function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash);
}

function quietMissingAudio(): void {
  const sound = window.BattleSound as {
    muted?: boolean;
    bgmVolume?: number;
    effectVolume?: number;
  } | undefined;
  if (!sound) return;
  // The vendored client requests mp3 cries and BGM that are not shipped.
  sound.muted = true;
  sound.bgmVolume = 0;
  sound.effectVolume = 0;
}

function getJQuery(element: HTMLElement): unknown {
  const jquery = window.jQuery ?? window.$;
  if (!jquery) throw new Error('Showdown jQuery runtime is not available.');
  return jquery(element);
}

function normalizeRequest(
  payload: unknown,
  battle: ShowdownBattle | null,
): ShowdownRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const request = payload as ShowdownRequest;
  if (window.BattleChoiceBuilder?.fixRequest && battle) {
    window.BattleChoiceBuilder.fixRequest(request, battle);
  }
  return request;
}

function ownViewpoint(sides: SideView[] | undefined, playerId: string): 'p1' | 'p2' {
  return sides?.[1]?.playerId === playerId ? 'p2' : 'p1';
}

function applyProtocolLines(
  battle: ShowdownBattle,
  lines: readonly string[],
  catchUp: boolean,
): void {
  if (!lines.length) return;
  if (!catchUp) {
    for (const line of lines) battle.add(line);
    return;
  }
  battle.paused = true;
  for (const line of lines) battle.add(line);
  battle.seekTurn(Number.POSITIVE_INFINITY);
  let resumed = false;
  const resume = () => {
    if (resumed) return;
    resumed = true;
    battle.play();
  };
  if (battle.atQueueEnd) {
    resume();
    return;
  }
  const previous = battle.subscription;
  battle.subscription = state => {
    previous?.(state);
    if (state === 'atqueueend') resume();
  };
}

function applyViewpoint(battle: ShowdownBattle, viewpoint: 'p1' | 'p2') {
  battle.setViewpoint(viewpoint);
  const parser = battle.scene?.log?.battleParser;
  if (parser) parser.perspective = viewpoint;
}

function railRole(you: boolean, watching: boolean, align: 'near' | 'far'): string {
  if (you) return 'You';
  if (watching) return align === 'near' ? 'Home' : 'Away';
  return 'Rival';
}

function FightRail({
  side,
  align,
  watching = false,
}: {
  side?: SideView;
  align: 'near' | 'far';
  watching?: boolean;
}) {
  const { playerId, trainerUsername, trainers } = useArena();
  const you = Boolean(side && playerId && side.playerId === playerId);
  const role = railRole(you, watching, align);
  const name = publicTrainerName(
    side?.playerId,
    trainers,
    { id: playerId, username: trainerUsername },
    side?.name,
  );
  const party = side?.party ?? [];
  const standing = party.filter(mon => !mon.fainted).length;
  const faintedCount = party.filter(mon => mon.fainted).length;
  const active = side?.active;
  const hp = typeof active?.hpPercent === 'number' ? active.hpPercent : null;
  const pulse = useDeltaPulse(hp);
  const down = Boolean(active?.fainted || hp === 0);
  return (
    <aside className={`fight-rail fight-rail-${align}`}>
      <div className="fight-rail-body">
        <div className="fight-rail-card">
          {align === 'near' ? <span className="fight-rail-role">{role}</span> : null}
          <span className="fight-rail-sprite">
              <ProfileTrainerSprite label={side?.playerId || name} side={align === 'near' ? 'left' : 'right'} />
            </span>
            <strong className="fight-rail-name">{name}</strong>
            <dl className="fight-rail-stats">
              <div>
                <dd>{party.length ? standing : '—'}</dd>
                <dt>Standing</dt>
              </div>
              <div>
                <dd>{party.length ? faintedCount : '—'}</dd>
                <dt>Down</dt>
              </div>
            </dl>
            {active ? (
              <div className={`fight-rail-active${pulse ? ` is-${pulse}` : ''}${down ? ' is-down' : ''}`}>
                <span>In play</span>
                <b key={active.species} className="fight-rail-active-name">{active.species}</b>
                {active.status ? <small key={active.status} className="fight-rail-status">{active.status}</small> : null}
                {hp !== null ? (
                  <i
                    className={hp > 50 ? 'hp-high' : hp > 20 ? 'hp-mid' : 'hp-low'}
                    aria-label={`${hp}% HP`}
                  >
                    <em style={{ transform: `scaleX(${hpScale(hp)})` }} />
                  </i>
                ) : null}
              </div>
            ) : null}
            {align === 'far' ? <span className="fight-rail-role">{role}</span> : null}
          </div>
          <span className="fight-rail-team">
            {Array.from({ length: 6 }, (_, index) => {
              const mon = party[index];
              return mon ? (
                <span key={`${mon.species}-${index}`} className={`fight-rail-mon${mon.fainted ? ' is-fainted' : ''}`} title={mon.species}>
                  <PokemonSprite name={mon.species} />
                </span>
              ) : (
                <span key={`empty-${index}`} className="fight-rail-mon is-empty" aria-hidden />
              );
            })}
          </span>
        </div>
    </aside>
  );
}

function speciesLabel(pokemon: {
  ident?: string;
  details?: string;
}, index: number): string {
  const fromDetails = pokemon.details?.split(',')[0]?.trim();
  if (fromDetails) return fromDetails;
  const fromIdent = pokemon.ident?.replace(/^p[12][a-z]?:\s*/i, '').trim();
  return fromIdent || `Slot ${index + 1}`;
}

type ChoiceKind = 'move' | 'switch' | 'confirm';

type FightChoice = {
  key: string;
  label: string;
  choice: string;
  kind: ChoiceKind;
  detail?: string;
  disabled?: boolean;
  species?: string;
  condition?: string;
  move?: EnrichedMove;
};

function FightMoveCard({
  choice,
  disabled,
  teraArmed,
  onPick,
}: {
  choice: FightChoice;
  disabled: boolean;
  teraArmed: boolean;
  onPick: (choiceText: string) => void;
}) {
  const move = choice.move;
  const category = move?.category?.toLowerCase();
  return (
    <button
      type="button"
      className={`fight-move${category ? ` is-${category}` : ''}${choice.disabled ? ' is-locked' : ''}${teraArmed ? ' is-tera' : ''}`}
      data-type={move?.type?.toLowerCase() || 'unknown'}
      disabled={disabled || choice.disabled}
      title={move?.shortDesc}
      onClick={() => onPick(teraArmed ? `${choice.choice} terastallize` : choice.choice)}
    >
      <span className="fight-move-head">
        {move?.type ? <TypeMark type={move.type} /> : null}
        <strong>{choice.label}</strong>
        {move?.category ? <span className={`fight-cat is-${category}`}>{move.category}</span> : null}
      </span>
      <span className="fight-move-stats">
        <span><b>{move?.powerLabel ?? '—'}</b><small>Power</small></span>
        <span><b>{move?.accuracyLabel ?? '—'}</b><small>Acc</small></span>
        <span><b>{move?.ppLabel?.replace(' PP', '') ?? '—'}</b><small>PP</small></span>
      </span>
      {move?.shortDesc ? <span className="fight-move-effect">{move.shortDesc}</span> : null}
    </button>
  );
}

function FightSwitchCard({
  choice,
  disabled,
  onPick,
}: {
  choice: FightChoice;
  disabled: boolean;
  onPick: (choiceText: string) => void;
}) {
  const parsed = parsePokemonCondition(choice.condition);
  const percent = parsed.percent;
  return (
    <button
      type="button"
      className={`fight-switch${parsed.fainted ? ' is-fainted' : ''}`}
      disabled={disabled}
      onClick={() => onPick(choice.choice)}
    >
      <span className="fight-switch-icon">
        <PokemonIcon name={choice.species || choice.label} />
      </span>
      <span className="fight-switch-copy">
        <strong>{choice.label}</strong>
        <small>{formatSwitchMeta(choice.condition)}</small>
        {percent != null ? (
          <i
            className={`fight-switch-hp ${percent > 50 ? 'hp-high' : percent > 20 ? 'hp-mid' : 'hp-low'}`}
            aria-hidden
          >
            <em style={{ transform: `scaleX(${hpScale(percent)})` }} />
          </i>
        ) : null}
      </span>
    </button>
  );
}

export function ShowdownBattle({
  playerId,
  matchId,
  battleInstanceId,
  battleView,
  events,
  client,
  onError,
  mode = 'play',
}: {
  playerId: string;
  matchId: string;
  battleInstanceId?: string;
  battleView: BattleView | null;
  events: unknown[];
  client: ArenaApiClient;
  onError: (message: string) => void;
  mode?: 'play' | 'watch';
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const battleRef = useRef<ShowdownBattle | null>(null);
  const sequenceRef = useRef(0);
  const eventsRef = useRef(events);
  const battleViewRef = useRef(battleView);
  const [requestState, setRequestState] = useState<{
    playerId: string;
    payload: ShowdownRequest;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);
  const [teraArmed, setTeraArmed] = useState(false);
  const [choiceLocked, setChoiceLocked] = useState(false);
  const [retainedChoices, setRetainedChoices] = useState<FightChoice[]>([]);
  const [retainedTeraType, setRetainedTeraType] = useState<string>();
  const [showBattleLog, setShowBattleLog] = useState(false);
  const watching = mode === 'watch';
  const backgroundName = SHOWDOWN_BATTLE_BACKGROUNDS[
    stableHash(matchId) % SHOWDOWN_BATTLE_BACKGROUNDS.length
  ];
  const battleStyle = {
    '--showdown-backdrop': `url('/showdown/fx/${backgroundName}.png')`,
  } as CSSProperties;

  eventsRef.current = events;
  battleViewRef.current = battleView;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const inMatch = Boolean(battleView?.sides?.some(side => side.playerId === playerId));
  const viewpoint = watching && !inMatch ? 'p1' : ownViewpoint(battleView?.sides, playerId);

  const rendererKey = `${matchId}:${battleInstanceId ?? 'pending'}`;

  const consumeEvents = useCallback((nextEvents: unknown[]) => {
    const battle = battleRef.current;
    if (!battle) return;

    const feed = eventsToShowdownFeed(
      nextEvents as Array<{
        sequence: number;
        scope: 'public' | 'private';
        playerId?: string;
        kind: string;
        data: string;
      }>,
      sequenceRef.current,
      playerId,
    );
    applyProtocolLines(battle, feed.publicLines, shouldCatchUpShowdownFeed(
      sequenceRef.current,
      feed.publicLines,
    ));
    if (!watching) {
      const latest = latestRequestPayload(feed.requestPayloads);
      if (latest !== undefined) {
        const normalized = normalizeRequest(latest, battle);
        if (normalized) setRequestState({ playerId, payload: normalized });
      }
    }
    sequenceRef.current = feed.lastSequence;
  }, [playerId, watching]);

  useEffect(() => {
    let disposed = false;
    sequenceRef.current = 0;
    setReady(false);
    setRequestState(null);

    void acquireShowdownRuntime()
      .then(() => {
        if (disposed || !frameRef.current || !logRef.current || !window.Battle) return;
        quietMissingAudio();
        const battle = new window.Battle({
          id: `pokearena-${matchId}`,
          $frame: getJQuery(frameRef.current),
          $logFrame: getJQuery(logRef.current),
          log: [],
          paused: false,
          autoresize: true,
        });
        applyViewpoint(battle, viewpoint);
        battleRef.current = battle;
        setReady(true);
        consumeEvents(eventsRef.current);
      })
      .catch(error => {
        if (!disposed) onErrorRef.current(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      const battle = battleRef.current;
      battleRef.current = null;
      if (battle) battle.destroy();
      if (frameRef.current) frameRef.current.replaceChildren();
      if (logRef.current) logRef.current.replaceChildren();
      setReady(false);
      releaseShowdownRuntime();
    };
  }, [consumeEvents, matchId, rendererKey, viewpoint]);

  useEffect(() => {
    consumeEvents(events);
  }, [consumeEvents, events]);

  const requestPayload = requestState?.playerId === playerId
    ? requestState.payload
    : null;
  const fallbackRequest = battleView?.request;
  const request = requestPayload ?? (
    fallbackRequest?.choices?.length
      ? { requestType: fallbackRequest.kind as ShowdownRequest['requestType'] }
      : null
  );

  const submitChoice = useCallback(async (choiceText: string) => {
    const view = battleViewRef.current;
    if (watching || !battleInstanceId || !view?.request) return;
    setSubmitting(true);
    setChoiceLocked(true);
    setRequestState(null);
    try {
      const choice: PlayerChoice = showdownChoiceToPlayerChoice(choiceText);
      await client.request({
        type: 'match.choice',
        matchId,
        battleInstanceId,
        requestRevision: view.request.revision,
        choice,
      });
    } catch (error) {
      setChoiceLocked(false);
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [battleInstanceId, client, matchId, watching]);

  const choices = useMemo((): FightChoice[] => {
    if (watching || battleView?.result || battleView?.failure) return [];
    if (!request || request.wait || request.requestType === 'wait') return [];

    if (request.teamPreview || request.requestType === 'team') {
      return [{
        key: 'team',
        label: 'Confirm team',
        detail: 'Lock lead order and open the fight',
        choice: 'default',
        kind: 'confirm',
      }];
    }

    const result: FightChoice[] = [];
    const active = request.active?.[0];
    for (const [index, move] of (active?.moves ?? []).entries()) {
      const name = move.name || `Move ${index + 1}`;
      result.push({
        key: `move-${index}`,
        label: name,
        choice: `move ${index + 1}`,
        kind: 'move',
        disabled: Boolean(move.disabled),
        move: enrichMove(name, { pp: move.pp, maxpp: move.maxpp }),
      });
    }
    if (!active?.trapped) {
      for (const [index, pokemon] of (request.side?.pokemon ?? []).entries()) {
        if (pokemon.active || String(pokemon.condition ?? '').endsWith(' fnt')) continue;
        const label = speciesLabel(pokemon, index);
        result.push({
          key: `switch-${index}`,
          label,
          species: label,
          condition: pokemon.condition,
          choice: `switch ${index + 1}`,
          kind: 'switch',
        });
      }
    }
    return result;
  }, [battleView?.failure, battleView?.result, request, watching]);

  const phaseKey = battleView?.result
    ? 'complete'
    : !ready
      ? 'loading'
      : submitting
        ? 'sending'
        : request?.teamPreview || request?.requestType === 'team'
          ? 'preview'
          : choices.length
            ? 'turn'
            : 'wait';

  const phaseLabel = battleView?.result
    ? 'Fight complete'
    : !ready
      ? 'Loading stage…'
      : submitting
        ? 'Sending choice…'
        : request?.teamPreview || request?.requestType === 'team'
          ? 'Team preview'
          : choices.length
            ? 'Your turn'
            : 'Waiting on the next request';

  const teraType = request?.active?.[0]?.canTerastallize;
  const canShowRetainedChoices = !watching && !battleView?.result && !battleView?.failure;
  const visibleChoices = canShowRetainedChoices
    ? (choices.length ? choices : retainedChoices)
    : [];
  const visibleMoves = visibleChoices.filter(choice => choice.kind === 'move');
  const visibleSwitches = visibleChoices.filter(choice => choice.kind === 'switch');
  const visibleConfirms = visibleChoices.filter(choice => choice.kind === 'confirm');
  const visibleTeraType = choices.length ? teraType : retainedTeraType;
  const controlsLocked = choiceLocked || (!choices.length && visibleChoices.length > 0);
  const canTera = Boolean(visibleTeraType) && visibleMoves.length > 0;

  useEffect(() => {
    if (!choices.length || battleView?.result || battleView?.failure) return;
    setRetainedChoices(choices);
    setRetainedTeraType(teraType);
  }, [battleView?.failure, battleView?.result, choices, teraType]);

  useEffect(() => {
    if (choiceLocked && requestState?.payload) setChoiceLocked(false);
  }, [choiceLocked, requestState]);

  useEffect(() => {
    setTeraArmed(false);
  }, [request?.rqid, teraType]);

  useEffect(() => {
    setShowBattleLog(false);
  }, [matchId]);

  const battleLogId = `showdown-log-${stableHash(matchId)}`;

  return (
    <section
      className={`showdown-battle-root dark${watching ? ' is-watch' : ''}${battleView?.result ? ` is-settled is-${battleView.result.status}` : ''}`}
      style={battleStyle}
      data-testid={watching ? 'showdown-battle-watch' : 'showdown-battle'}
      aria-label={watching ? 'Live spectator battle feed. This match is not playable from here.' : undefined}
    >
      <div className="showdown-battle-stage">
        <div className="showdown-battle-frame">
          <FightRail
            side={battleView?.sides[viewpoint === 'p2' ? 1 : 0]}
            align="near"
            watching={watching}
          />
          <div className="showdown-battle-scene">
            <div ref={frameRef} className="battle" data-testid="showdown-frame" />
          </div>
          <FightRail
            side={battleView?.sides[viewpoint === 'p2' ? 0 : 1]}
            align="far"
            watching={watching}
          />
        </div>
        <div className={`showdown-battle-log-drawer${showBattleLog ? ' is-open' : ''}`}>
          <div
            ref={logRef}
            id={battleLogId}
            className="battle-log"
            data-testid="showdown-log"
            aria-hidden={!showBattleLog || watching}
          />
        </div>
      </div>
      {watching ? (
      <div className="showdown-battle-controls is-idle">
        <div className="showdown-battle-controls-header">
          <span className="showdown-controls-label">Spectator feed</span>
          <span className="showdown-phase">Watching · no moves</span>
        </div>
      </div>
      ) : (
      <div className={`showdown-battle-controls${visibleChoices.length ? '' : ' is-idle'}${controlsLocked ? ' is-choice-locked' : ''} is-${phaseKey}`}>
        <div className="showdown-battle-controls-header">
          <span className="showdown-controls-label">Fight controls</span>
          <div className="showdown-battle-controls-status">
            <span className="showdown-phase">{phaseLabel}</span>
            <button
              type="button"
              className="showdown-log-toggle"
              aria-controls={battleLogId}
              aria-expanded={showBattleLog}
              aria-label={showBattleLog ? 'Hide battle log' : 'Show battle log'}
              onClick={() => setShowBattleLog(current => !current)}
            >
              <span aria-hidden="true">{showBattleLog ? '⌄' : '⌃'}</span>
              <span>Battle log</span>
            </button>
          </div>
        </div>
        {visibleChoices.length ? (
          <div className="fight-dock">
            {visibleConfirms.length ? (
              <div className="fight-band fight-band-confirm">
                {visibleConfirms.map(choice => (
                  <button
                    key={choice.key}
                    type="button"
                    className="pa-btn pa-btn-primary fight-confirm"
                    disabled={submitting || !ready || controlsLocked}
                    onClick={() => void submitChoice(choice.choice)}
                  >
                    <strong>{choice.label}</strong>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {canTera ? (
              <div className="fight-band fight-band-meta">
                <button
                  type="button"
                  className={`fight-tera${teraArmed ? ' is-on' : ''}`}
                  disabled={submitting || !ready || controlsLocked}
                  aria-pressed={teraArmed}
                  onClick={() => setTeraArmed(current => !current)}
                >
                  <span>Terastallize · {visibleTeraType}</span>
                  <small>{teraArmed ? 'Armed · next attack teras' : 'Tap to arm, then pick an attack'}</small>
                </button>
              </div>
            ) : null}
            {visibleMoves.length ? (
              <section className="fight-band fight-band-attacks" aria-label="Attacks">
                <header>Attacks</header>
                <div className="fight-move-grid">
                  {visibleMoves.map(choice => (
                    <FightMoveCard
                      key={choice.key}
                      choice={choice}
                      disabled={submitting || !ready || controlsLocked}
                      teraArmed={canTera && teraArmed}
                      onPick={choiceText => void submitChoice(choiceText)}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {visibleSwitches.length ? (
              <section className="fight-band fight-band-bench" aria-label="Switch in">
                <header>Switch in</header>
                <div className="fight-switch-row">
                  {visibleSwitches.map(choice => (
                    <FightSwitchCard
                      key={choice.key}
                      choice={choice}
                      disabled={submitting || !ready || controlsLocked}
                      onPick={choiceText => void submitChoice(choiceText)}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <p className="showdown-wait">
            {battleView?.result ? 'Battle complete.' : 'Waiting for the next private request.'}
          </p>
        )}
      </div>
      )}
    </section>
  );
}
