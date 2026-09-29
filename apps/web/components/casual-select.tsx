'use client';

import { PokemonIcon, TypeMark } from '@/components/showdown-visuals';
import type { CasualPreviewMon, CasualTeamPreview } from '@/lib/protocol';

export function CasualSelectBoard({
  yours,
  rival,
  selected,
  confirmed,
  rivalConfirmed,
  revealed,
  disabled,
  onToggle,
}: {
  yours?: CasualTeamPreview;
  rival?: CasualTeamPreview;
  selected: readonly number[];
  confirmed: boolean;
  rivalConfirmed: boolean;
  revealed: boolean;
  disabled?: boolean;
  onToggle: (slot: number) => void;
}) {
  return (
    <div className="pa-casual-select">
      <CasualPreviewColumn
        title={yours ? yours.presetName : 'Your team'}
        kicker="Your six"
        preview={yours}
        selected={selected}
        selectable={!confirmed && !disabled}
        highlightSlots={selected}
        onToggle={onToggle}
      />
      <CasualPreviewColumn
        title={rival ? rival.presetName : 'Waiting…'}
        kicker={revealed ? 'Rival’s three' : rivalConfirmed ? 'Rival locked' : 'Rival’s six'}
        preview={rival}
        selected={revealed ? (rival?.selectedSlots ?? []) : []}
        selectable={false}
        highlightSlots={revealed ? (rival?.selectedSlots ?? []) : []}
        sealed={!revealed && rivalConfirmed}
      />
    </div>
  );
}

function CasualPreviewColumn({
  title,
  kicker,
  preview,
  selected,
  selectable,
  highlightSlots,
  sealed,
  onToggle,
}: {
  title: string;
  kicker: string;
  preview?: CasualTeamPreview;
  selected: readonly number[];
  selectable: boolean;
  highlightSlots: readonly number[];
  sealed?: boolean;
  onToggle?: (slot: number) => void;
}) {
  const pokemon = preview?.pokemon ?? [];
  return (
    <section className="pa-casual-column">
      <header>
        <small>{kicker}</small>
        <strong>{title}</strong>
      </header>
      <div className="pa-casual-grid">
        {(pokemon.length ? pokemon : Array.from({ length: 6 }, (_, slot) => ({
          slot,
          species: '',
          item: '',
          ability: '',
          nature: '',
          moves: [],
          types: [],
        } as CasualPreviewMon))).map(mon => {
          const picked = highlightSlots.includes(mon.slot);
          const full = selected.length >= 3;
          return (
            <button
              key={`${preview?.playerId ?? 'empty'}-${mon.slot}`}
              type="button"
              className={`pa-casual-mon${picked ? ' on' : ''}${sealed ? ' sealed' : ''}`}
              disabled={!selectable || !mon.species || (full && !picked)}
              onClick={() => onToggle?.(mon.slot)}
            >
              <span className="pa-casual-mon-head">
                {mon.species ? <PokemonIcon name={mon.species} /> : <span className="ps-icon ps-icon-empty" />}
                <b>{mon.species || '—'}</b>
              </span>
              {mon.types.length ? (
                <span className="pa-casual-types">
                  {mon.types.map(type => <TypeMark key={type} type={type} />)}
                </span>
              ) : null}
              <em>{[mon.ability, mon.item].filter(Boolean).join(' · ') || 'Locked'}</em>
              <ul>
                {(mon.moves.length ? mon.moves : ['—']).map(move => (
                  <li key={`${mon.slot}-${move}`}>{move}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
    </section>
  );
}
