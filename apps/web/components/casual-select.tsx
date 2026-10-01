'use client';

import type { CSSProperties } from 'react';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { PokemonSprite, TypeMark } from '@/components/showdown-visuals';
import type { CasualPreviewMon, CasualTeamPreview } from '@/lib/protocol';

/** How long the lock-in handoff stays up before the battle route opens. */
export const CASUAL_BATTLE_HANDOFF_MS = 1100;

const SETUP_MOVES = new Set([
  'Swords Dance', 'Nasty Plot', 'Dragon Dance', 'Calm Mind', 'Quiver Dance',
  'Shell Smash', 'Bulk Up', 'Agility',
]);

export function CasualSelectBoard({
  yours,
  selected,
  confirmed,
  rivalConfirmed,
  secondsLeft,
  disabled,
  busy,
  onToggle,
  onLock,
}: {
  yours?: CasualTeamPreview;
  selected: readonly number[];
  confirmed: boolean;
  rivalConfirmed: boolean;
  secondsLeft?: number | null;
  disabled?: boolean;
  busy?: boolean;
  /** Ignored. Kept so older call sites compile. Picks stay private until battle. */
  revealed?: boolean;
  onToggle: (slot: number) => void;
  onLock?: () => void;
}) {
  const pool = yours?.pokemon.length ? yours.pokemon : emptySix();
  const clock = secondsLeft == null ? null : formatClock(secondsLeft);
  const matchPhase = Boolean(onLock);
  return (
    <section className={`pa-choose${confirmed ? ' is-locked' : ''}`} aria-label="Choose your 3">
      <header className="pa-choose-head">
        <div>
          <small>Pre-battle</small>
          <h1>Choose your 3</h1>
          <p>Pick 3 Pokémon for this battle</p>
        </div>
        <div className="pa-choose-clock" role="timer" aria-live="polite">
          {clock ? <b>{clock}</b> : null}
          <em>{selected.length} / 3 selected</em>
        </div>
      </header>

      <div className="pa-choose-grid">
        {pool.map(mon => {
          const picked = selected.includes(mon.slot);
          const full = selected.length >= 3;
          return (
            <button
              key={`${yours?.presetId ?? 'pool'}-${mon.slot}`}
              type="button"
              className={`pa-choose-mon${picked ? ' on' : ''}${confirmed ? ' locked' : ''}`}
              disabled={confirmed || disabled || !mon.species || (full && !picked)}
              aria-pressed={picked}
              onClick={() => onToggle(mon.slot)}
            >
              <span className="pa-choose-art">
                {mon.species ? <PokemonSprite name={mon.species} /> : <span className="ps-sprite-frame empty" />}
              </span>
              <span className="pa-choose-copy">
                <strong>{mon.species || '—'}</strong>
                <em>{mon.species ? roleFor(mon) : 'Waiting'}</em>
                {mon.types.length ? (
                  <span className="pa-choose-types">
                    {mon.types.map(type => <TypeMark key={type} type={type} />)}
                  </span>
                ) : null}
                <span className="pa-choose-ability">{mon.ability || '—'}</span>
                <ul>
                  {(mon.moves.length ? mon.moves : ['—']).slice(0, 4).map(move => (
                    <li key={`${mon.slot}-${move}`}>{move}</li>
                  ))}
                </ul>
              </span>
              <i>{picked ? (confirmed ? 'Locked' : 'Selected') : 'Open'}</i>
            </button>
          );
        })}
      </div>

      <footer className="pa-choose-foot">
        <p>
          {matchPhase
            ? confirmed
              ? 'Locked in. Your three stay hidden until the battle starts.'
              : 'Your rival cannot see which Pokémon you pick.'
            : 'Pick any three from this shared six.'}
          {matchPhase ? ` ${rivalConfirmed ? 'Opponent locked in.' : 'Opponent is choosing…'}` : ''}
        </p>
        {matchPhase && confirmed ? (
          <strong className="pa-choose-ready">Ready</strong>
        ) : matchPhase ? (
          <button
            type="button"
            className="pa-btn pa-btn-gold"
            disabled={busy || disabled || selected.length !== 3}
            onClick={onLock}
          >
            Lock in
          </button>
        ) : null}
      </footer>
    </section>
  );
}

export function CasualBattleReveal({
  yourId,
  rivalId,
  durationMs = CASUAL_BATTLE_HANDOFF_MS,
}: {
  yourId: string;
  rivalId?: string;
  durationMs?: number;
}) {
  return (
    <section
      className="pa-match-vs"
      role="status"
      aria-live="assertive"
      style={{ '--pa-handoff': `${durationMs}ms` } as CSSProperties}
    >
      <div className="pa-match-vs-card">
        <header>
          <small>Both sides locked</small>
          <h2>Opening the fight</h2>
        </header>
        <div className="pa-lobby-vs">
          <article className="pa-lobby-side cyan is-present">
            <small>Your trainer</small>
            <ProfileTrainerSprite label={yourId} side="left" />
            <strong><TrainerName playerId={yourId} /></strong>
            <span className="pa-lobby-ready on">Locked</span>
          </article>
          <div className="pa-lobby-mid" aria-hidden>
            <span>VS</span>
          </div>
          <article className="pa-lobby-side coral is-present">
            <small>Opponent</small>
            {rivalId ? <ProfileTrainerSprite label={rivalId} side="right" /> : null}
            <strong>{rivalId ? <TrainerName playerId={rivalId} fallback="Rival" /> : 'Rival'}</strong>
            <span className="pa-lobby-ready on">Locked</span>
          </article>
        </div>
        <p>Teams stay hidden until the first send-out.</p>
        <div className="pa-match-vs-bar" aria-hidden>
          <i />
        </div>
      </div>
    </section>
  );
}

export function CasualCountdown({ seconds }: { seconds: number }) {
  const value = seconds > 0 ? seconds : 1;
  return (
    <section className="pa-match-count" role="status" aria-live="assertive">
      <small>Match starting</small>
      <b key={value}>{value}</b>
    </section>
  );
}

function roleFor(mon: CasualPreviewMon): string {
  if (mon.moves.some(move => SETUP_MOVES.has(move))) return 'Setup';
  if (mon.moves.some(move => /Protect|Recover|Roost|Wish|Toxic|Thunder Wave|Will-O-Wisp/.test(move))) {
    return 'Support';
  }
  return 'Attacker';
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function emptySix(): CasualPreviewMon[] {
  return Array.from({ length: 6 }, (_, slot) => ({
    slot,
    species: '',
    item: '',
    ability: '',
    nature: '',
    moves: [],
    types: [],
  }));
}
