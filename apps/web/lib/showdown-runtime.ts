import { applyShowdownSpriteCdn } from './showdown-visuals';

interface ShowdownAsset {
  kind: 'script' | 'style';
  path: string;
  global?: string;
}

const ASSETS: ShowdownAsset[] = [
  { kind: 'script', path: '/showdown/js/lib/ps-polyfill.js' },
  { kind: 'script', path: '/showdown/config.js', global: 'Config' },
  { kind: 'script', path: '/showdown/js/lib/jquery-3.7.1.min.js', global: 'jQuery' },
  { kind: 'script', path: '/showdown/js/lib/html-sanitizer-minified.js' },
  { kind: 'script', path: '/showdown/js/battle-sound.js', global: 'BattleSound' },
  { kind: 'script', path: '/showdown/js/battledata.js', global: 'Dex' },
  { kind: 'script', path: '/showdown/js/battle-log.js', global: 'BattleLog' },
  { kind: 'script', path: '/showdown/data/pokedex-mini.js', global: 'BattlePokemonSprites' },
  { kind: 'script', path: '/showdown/data/pokedex-mini-bw.js', global: 'BattlePokemonSpritesBW' },
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

function showdownDex() {
  return (window as Window & {
    Dex?: {
      resourcePrefix?: string;
      fxPrefix?: string;
      loadedSpriteData?: { xy?: number; bw?: number };
    };
  }).Dex;
}

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

export function acquireShowdownRuntime(): Promise<void> {
  runtimeUsers += 1;
  if (runtimeCleanup) {
    clearTimeout(runtimeCleanup);
    runtimeCleanup = null;
  }
  if (!runtimePromise) {
    previousGlobals = new Map(SHOWDOWN_GLOBALS.map(name => [name, window[name]]));
    runtimePromise = ASSETS.reduce(
      (promise, asset) => promise.then(async () => {
        await loadResource(asset);
        if (asset.global === 'Dex') applyShowdownSpriteCdn(showdownDex());
      }),
      Promise.resolve(),
    ).then(() => {
      applyShowdownSpriteCdn(showdownDex());
    });
  }
  return runtimePromise;
}

export function releaseShowdownRuntime(): void {
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
