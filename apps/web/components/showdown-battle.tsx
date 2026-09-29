'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ProfileTrainerSprite } from '@/components/profile-trainer';
import { PokemonSprite } from '@/components/showdown-visuals';
import { acquireShowdownRuntime, releaseShowdownRuntime } from '@/lib/showdown-runtime';
import type { ArenaApiClient } from '@/lib/api-client';
import { useArena } from '@/lib/arena-context';
import {
  eventsToShowdownFeed,
  latestRequestPayload,
  showdownChoiceToPlayerChoice,
} from '@/lib/showdown-client-adapter';
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
  const down = party.filter(mon => mon.fainted).length;
  const active = side?.active;
  const hp = typeof active?.hpPercent === 'number' ? active.hpPercent : null;
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
                <dd>{party.length ? down : '—'}</dd>
                <dt>Down</dt>
              </div>
            </dl>
            {active ? (
              <div className="fight-rail-active">
                <span>In play</span>
                <b>{active.species}</b>
                {hp !== null ? (
                  <i
                    className={hp > 50 ? 'hp-high' : hp > 20 ? 'hp-mid' : 'hp-low'}
                    aria-label={`${hp}% HP`}
                  >
                    <em style={{ width: `${Math.max(0, Math.min(100, hp))}%` }} />
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

type ChoiceKind = 'move' | 'switch' | 'tera' | 'confirm';

type FightChoice = {
  key: string;
  label: string;
  choice: string;
  kind: ChoiceKind;
  detail?: string;
};

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
  const watching = mode === 'watch';

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
    for (const line of feed.publicLines) battle.add(line);
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
      if (move.disabled) continue;
      result.push({
        key: `move-${index}`,
        label: move.name || `Move ${index + 1}`,
        detail: move.pp == null || move.maxpp == null ? undefined : `${move.pp}/${move.maxpp} PP`,
        choice: `move ${index + 1}`,
        kind: 'move',
      });
    }
    if (active?.canTerastallize) {
      result.push({
        key: 'tera',
        label: `Terastallize · ${active.canTerastallize}`,
        detail: 'Uses move 1',
        choice: 'move 1 terastallize',
        kind: 'tera',
      });
    }
    if (!active?.trapped) {
      for (const [index, pokemon] of (request.side?.pokemon ?? []).entries()) {
        if (pokemon.active || String(pokemon.condition ?? '').endsWith(' fnt')) continue;
        result.push({
          key: `switch-${index}`,
          label: speciesLabel(pokemon, index),
          detail: 'Switch in',
          choice: `switch ${index + 1}`,
          kind: 'switch',
        });
      }
    }
    return result;
  }, [battleView?.failure, battleView?.result, request, watching]);

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

  const moves = choices.filter(choice => choice.kind === 'move' || choice.kind === 'tera');
  const switches = choices.filter(choice => choice.kind === 'switch');
  const confirms = choices.filter(choice => choice.kind === 'confirm');

  return (
    <section
      className={`showdown-battle-root dark${watching ? ' is-watch' : ''}`}
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
        <div
          ref={logRef}
          className="battle-log"
          data-testid="showdown-log"
          hidden={watching}
          aria-hidden={watching}
        />
      </div>
      {watching ? (
      <div className="showdown-battle-controls is-idle">
        <div className="showdown-battle-controls-header">
          <span className="showdown-controls-label">Spectator feed</span>
          <span className="showdown-phase">Watching · no moves</span>
        </div>
      </div>
      ) : (
      <div className={`showdown-battle-controls${choices.length ? '' : ' is-idle'}`}>
        <div className="showdown-battle-controls-header">
          <span className="showdown-controls-label">Fight controls</span>
          <span className="showdown-phase">{phaseLabel}</span>
        </div>
        {choices.length ? (
          <div className="showdown-choice-stack">
            {confirms.length ? (
              <div className="showdown-choice-confirm">
                {confirms.map(choice => (
                  <button
                    key={choice.key}
                    type="button"
                    className="pa-btn pa-btn-primary showdown-choice confirm"
                    disabled={submitting || !ready}
                    onClick={() => void submitChoice(choice.choice)}
                  >
                    <strong>{choice.label}</strong>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {moves.length ? (
              <div className="showdown-choice-grid moves">
                {moves.map(choice => (
                  <button
                    key={choice.key}
                    type="button"
                    className={`pa-btn showdown-choice ${choice.kind}`}
                    disabled={submitting || !ready}
                    onClick={() => void submitChoice(choice.choice)}
                  >
                    <strong>{choice.label}</strong>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {switches.length ? (
              <div className="showdown-choice-grid switches">
                {switches.map(choice => (
                  <button
                    key={choice.key}
                    type="button"
                    className="pa-btn showdown-choice switch"
                    disabled={submitting || !ready}
                    onClick={() => void submitChoice(choice.choice)}
                  >
                    <strong>{choice.label}</strong>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </button>
                ))}
              </div>
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
