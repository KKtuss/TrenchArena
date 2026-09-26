'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ArenaApiClient } from '@/lib/api-client';
import {
  eventsToShowdownFeed,
  latestRequestPayload,
  showdownChoiceToPlayerChoice,
} from '@/lib/showdown-client-adapter';
import type { BattleView, PlayerChoice } from '@/lib/protocol';

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

interface ShowdownAsset {
  kind: 'script' | 'style';
  path: string;
  global?: string;
}

const ASSETS: ShowdownAsset[] = [
  { kind: 'script', path: '/showdown/js/lib/ps-polyfill.js' },
  { kind: 'script', path: '/showdown/config.js', global: 'Config' },
  { kind: 'script', path: '/showdown/js/lib/jquery-1.11.0.min.js', global: 'jQuery' },
  { kind: 'script', path: '/showdown/js/lib/html-sanitizer-minified.js' },
  { kind: 'script', path: '/showdown/js/battle-sound.js', global: 'BattleSound' },
  { kind: 'script', path: '/showdown/js/battledata.js', global: 'Dex' },
  { kind: 'script', path: '/showdown/js/battle-log.js', global: 'BattleLog' },
  { kind: 'script', path: '/showdown/data/pokedex.js', global: 'BattlePokedex' },
  { kind: 'script', path: '/showdown/data/moves.js', global: 'BattleMovedex' },
  { kind: 'script', path: '/showdown/data/abilities.js', global: 'BattleAbilities' },
  { kind: 'script', path: '/showdown/data/items.js', global: 'BattleItems' },
  { kind: 'script', path: '/showdown/data/teambuilder-tables.js', global: 'BattleTeambuilderTable' },
  { kind: 'script', path: '/showdown/data/graphics.js', global: 'BattleScene' },
  { kind: 'script', path: '/showdown/js/battle-tooltips.js', global: 'BattleTooltips' },
  { kind: 'script', path: '/showdown/js/battle.js', global: 'Battle' },
  { kind: 'script', path: '/showdown/js/battle-choices.js', global: 'BattleChoiceBuilder' },
  { kind: 'style', path: '/showdown/style/font-awesome.css' },
  { kind: 'style', path: '/showdown/style/battle.css' },
  { kind: 'style', path: '/showdown/style/replay.css' },
];

const SHOWDOWN_GLOBALS = [
  'Battle',
  'BattleChoiceBuilder',
  'BattleLog',
  'BattleScene',
  'BattleSound',
  'BattleText',
  'BattlePokedex',
  'BattleMovedex',
  'BattleAbilities',
  'BattleItems',
  'BattleTeambuilderTable',
  'BattlePokemonSprites',
  'BattlePokemonSpritesBW',
  'Config',
  'Dex',
  '$',
  'jQuery',
];

let runtimePromise: Promise<void> | null = null;
let runtimeUsers = 0;
let runtimeCleanup: ReturnType<typeof setTimeout> | null = null;
let previousGlobals: Map<string, unknown> | null = null;

function loadResource(asset: ShowdownAsset): Promise<void> {
  const selector = `[data-pokearena-showdown="${CSS.escape(asset.path)}"]`;
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const element = asset.kind === 'script'
      ? document.createElement('script')
      : document.createElement('link');
    element.dataset.pokearenaShowdown = asset.path;
    if (asset.kind === 'script') {
      const script = element as HTMLScriptElement;
      script.src = asset.path;
      script.async = false;
    } else {
      const link = element as HTMLLinkElement;
      link.rel = 'stylesheet';
      link.href = asset.path;
    }
    element.addEventListener('load', () => resolve(), { once: true });
    element.addEventListener('error', () => reject(new Error(`Failed to load ${asset.path}`)), { once: true });
    document.head.appendChild(element);
  });
}

function acquireShowdownRuntime(): Promise<void> {
  runtimeUsers += 1;
  if (runtimeCleanup) {
    clearTimeout(runtimeCleanup);
    runtimeCleanup = null;
  }
  if (!runtimePromise) {
    previousGlobals = new Map(SHOWDOWN_GLOBALS.map(name => [name, window[name]]));
    runtimePromise = ASSETS.reduce(
      (promise, asset) => promise.then(() => loadResource(asset)),
      Promise.resolve(),
    );
  }
  return runtimePromise;
}

function releaseShowdownRuntime(): void {
  runtimeUsers = Math.max(0, runtimeUsers - 1);
  if (runtimeUsers !== 0 || runtimeCleanup) return;

  runtimeCleanup = setTimeout(() => {
    runtimeCleanup = null;
    if (runtimeUsers !== 0) return;
    for (const element of document.querySelectorAll('[data-pokearena-showdown]')) {
      element.remove();
    }
    for (const name of SHOWDOWN_GLOBALS) {
      const previous = previousGlobals?.get(name);
      try {
        if (previous === undefined) {
          delete window[name];
        } else {
          window[name] = previous;
        }
      } catch {
        // Showdown declares Battle and its siblings as global functions.
        // Those window properties cannot be deleted.
        try {
          window[name] = previous;
        } catch {
          // Leave the non-configurable global in place.
        }
      }
    }
    previousGlobals = null;
    runtimePromise = null;
  }, 0);
}

export const __showdownRuntimeForTest = {
  acquire: acquireShowdownRuntime,
  release: releaseShowdownRuntime,
  assetCount: ASSETS.length,
};

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
}: {
  playerId: string;
  matchId: string;
  battleInstanceId?: string;
  battleView: BattleView | null;
  events: unknown[];
  client: ArenaApiClient;
  onError: (message: string) => void;
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

  eventsRef.current = events;
  battleViewRef.current = battleView;

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
    const latest = latestRequestPayload(feed.requestPayloads);
    if (latest !== undefined) {
      const normalized = normalizeRequest(latest, battle);
      if (normalized) setRequestState({ playerId, payload: normalized });
    }
    sequenceRef.current = feed.lastSequence;
  }, [playerId]);

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
        battleRef.current = battle;
        setReady(true);
        consumeEvents(eventsRef.current);
      })
      .catch(error => {
        if (!disposed) onError(error instanceof Error ? error.message : String(error));
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
  }, [consumeEvents, matchId, onError, rendererKey]);

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
    if (!battleInstanceId || !view?.request) return;
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
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [battleInstanceId, client, matchId, onError]);

  const choices = useMemo((): FightChoice[] => {
    if (battleView?.result || battleView?.failure) return [];
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
  }, [battleView?.failure, battleView?.result, request]);

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
    <section className="showdown-battle-root dark" data-testid="showdown-battle">
      <div className="showdown-battle-stage">
        <div className="showdown-battle-frame">
          <div ref={frameRef} className="battle" data-testid="showdown-frame" />
        </div>
        <div ref={logRef} className="battle-log" data-testid="showdown-log" />
      </div>
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
    </section>
  );
}
