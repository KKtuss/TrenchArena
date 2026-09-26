'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { PokemonIcon, PokemonSprite, TypeMark } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import {
  NATURES,
  STATS,
  TERA_TYPES,
  emptySet,
  readSavedTeam,
  setsFromInspection,
  setsToPaste,
  writeSavedTeam,
  type EditorSet,
  type StatId,
  type TeamInspection,
} from '@/lib/team';

type SearchField = `species` | `item` | `ability` | `move-${number}`;

const STAT_LABEL: Record<StatId, string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spa: 'SpA',
  spd: 'SpD',
  spe: 'Spe',
};

export function TeamBuilder() {
  const { client, playerId, connected } = useArena();
  const [name, setName] = useState('Circuit Six');
  const [sets, setSets] = useState<EditorSet[]>(() => Array.from({ length: 6 }, emptySet));
  const [selected, setSelected] = useState(0);
  const [inspection, setInspection] = useState<TeamInspection | null>(null);
  const [notice, setNotice] = useState('Loading the Gen 9 OU validator.');
  const [importOpen, setImportOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const [suggestions, setSuggestions] = useState<{ field: SearchField; results: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const inspectGeneration = useRef(0);
  const searchGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    async function load() {
      const stored = readSavedTeam(playerId);
      try {
        if (stored) {
          const message = await client.request({ type: 'team.inspect', team: stored.paste });
          if (cancelled || message.type !== 'team.inspect') return;
          setName(stored.name);
          setSets(setsFromInspection(message.inspection));
          setInspection(message.inspection);
          setPaste(stored.paste);
          setNotice(message.inspection.packed ? 'Saved team passes Gen 9 OU.' : 'Saved draft still has clause problems.');
          setSaved(true);
          setHydrated(true);
          return;
        }
        const starter = await client.request({ type: 'team.starter' });
        if (cancelled || starter.type !== 'team.starter') return;
        const message = await client.request({ type: 'team.inspect', team: starter.paste });
        if (cancelled || message.type !== 'team.inspect') return;
        setName(starter.name);
        setSets(setsFromInspection(message.inspection));
        setInspection(message.inspection);
        setPaste(starter.paste);
        setNotice('Starter team passes Gen 9 OU. Edit a slot, then save.');
        setHydrated(true);
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : 'Validator unavailable.');
          setHydrated(true);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, playerId]);

  useEffect(() => {
    if (!hydrated) return undefined;
    const generation = ++inspectGeneration.current;
    const handle = window.setTimeout(() => {
      const nextPaste = setsToPaste(sets);
      void client.request({ type: 'team.inspect', team: nextPaste || 'Empty' }).then(message => {
        if (generation !== inspectGeneration.current) return;
        if (message.type === 'team.inspect') setInspection(message.inspection);
      }).catch(error => {
        if (generation !== inspectGeneration.current) return;
        setNotice(error instanceof Error ? error.message : 'Validator unavailable.');
      });
    }, 280);
    return () => window.clearTimeout(handle);
  }, [client, hydrated, sets]);

  const current = sets[selected] ?? emptySet();
  const detail = useMemo(() => {
    if (!inspection || !current.species.trim()) return undefined;
    const position = sets.slice(0, selected + 1).filter(set => set.species.trim()).length - 1;
    return inspection.sets[position];
  }, [current.species, inspection, selected, sets]);

  const evSpent = STATS.reduce((sum, stat) => sum + (current.evs[stat.id] || 0), 0);

  function updateSet(patch: Partial<EditorSet>) {
    setSaved(false);
    setSets(existing => existing.map((set, index) => index === selected ? { ...set, ...patch } : set));
  }

  function updateEv(stat: StatId, raw: string) {
    const value = Math.max(0, Math.min(252, Number(raw) || 0));
    updateSet({ evs: { ...current.evs, [stat]: value } });
  }

  function updateMove(slot: number, value: string) {
    const moves = [...current.moves] as EditorSet['moves'];
    moves[slot] = value;
    updateSet({ moves });
  }

  async function search(field: SearchField, kind: 'species' | 'move' | 'item' | 'ability', query: string) {
    if (query.trim().length < 1 && kind !== 'ability') {
      setSuggestions(null);
      return;
    }
    const generation = ++searchGeneration.current;
    try {
      const message = await client.request({
        type: 'team.search',
        kind,
        query,
        ...(kind === 'ability' && current.species.trim() ? { species: current.species.trim() } : {}),
      });
      if (generation !== searchGeneration.current) return;
      if (message.type === 'team.search') setSuggestions({ field, results: message.results });
    } catch {
      if (generation === searchGeneration.current) setSuggestions(null);
    }
  }

  function applySuggestion(field: SearchField, value: string) {
    if (field === 'species') updateSet({ species: value });
    else if (field === 'item') updateSet({ item: value });
    else if (field === 'ability') updateSet({ ability: value });
    else updateMove(Number(field.slice(5)), value);
    setSuggestions(null);
  }

  async function applyPaste() {
    try {
      const message = await client.request({ type: 'team.inspect', team: paste });
      if (message.type !== 'team.inspect') return;
      setSets(setsFromInspection(message.inspection));
      setInspection(message.inspection);
      setSelected(0);
      setSaved(false);
      setNotice(message.inspection.packed ? 'Imported paste passes Gen 9 OU.' : 'Imported paste still has clause problems.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Import failed.');
    }
  }

  function save() {
    const nextPaste = setsToPaste(sets);
    writeSavedTeam(playerId, {
      name: name.trim() || 'Untitled protocol',
      paste: nextPaste,
      species: sets.map(set => set.species.trim()).filter(Boolean),
      validated: Boolean(inspection?.packed),
    });
    setSaved(true);
    setNotice(inspection?.packed
      ? 'Saved on this browser. Ready up or register to bring this protocol.'
      : 'Draft saved. It does not pass Gen 9 OU, so a match will bring the circuit roster.');
  }

  return (
    <div className="tb">
      <header className="tb-file">
        <div>
          <p>Tactical deployment file · prod sync · regulation compliant</p>
          <input aria-label="Team name" value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
        </div>
        <div className="tb-file-actions">
          <span>Format: Gen 9 Overused</span>
          <button type="button" onClick={() => {
            setPaste(setsToPaste(sets));
            setImportOpen(open => !open);
          }}>Import / export</button>
          <button type="button" className="primary" onClick={save}>{saved ? 'Saved' : 'Save protocol'}</button>
        </div>
      </header>

      <p className={`tb-status ${inspection?.packed ? 'ok' : ''}`}>
        {connected ? notice : 'Connecting to the validator…'}
        {inspection?.packed ? ' · 0 clause violations' : ''}
      </p>

      {importOpen ? (
        <div className="tb-import">
          <textarea aria-label="Showdown paste" value={paste} onChange={event => setPaste(event.target.value)} rows={8} />
          <button type="button" onClick={() => void applyPaste()}>Apply paste</button>
        </div>
      ) : null}

      {inspection && !inspection.packed && inspection.problems.length ? (
        <ul className="tb-problems">
          {inspection.problems.slice(0, 6).map(problem => <li key={problem}>{problem}</li>)}
        </ul>
      ) : null}

      <div className="tb-grid">
        <aside className="tb-slots">
          {sets.map((set, index) => (
            <button
              key={index}
              type="button"
              className={index === selected ? 'active' : ''}
              onClick={() => { setSelected(index); setSuggestions(null); }}
            >
              <small>Slot {String(index + 1).padStart(2, '0')}{index === selected ? ' // active' : ''}</small>
              <span className="tb-slot-ident">
                {set.species.trim() ? <PokemonIcon name={set.species} /> : <PokemonIcon name="" />}
                <strong>{set.species.trim() || 'Empty slot'}</strong>
              </span>
              <span>{set.ability || 'No ability'}{set.item ? ` · ${set.item}` : ''}</span>
              {set.teraType ? <em>Tera {set.teraType}</em> : null}
            </button>
          ))}
        </aside>

        <section className="tb-set">
          <header>
            <div className="tb-set-head">
              {current.species.trim() ? (
                <PokemonSprite name={current.species} dexNum={detail?.dexNum} />
              ) : null}
              <div>
                <small>{detail?.dexNum ? `Natdex #${String(detail.dexNum).padStart(4, '0')}` : 'Species ident'}</small>
                <h2>{current.species.trim() || 'Choose a species'}</h2>
              </div>
            </div>
            <div className="tb-types">
              {(detail?.types ?? []).map(type => (
                <span key={type}><TypeMark type={type} />{type}</span>
              ))}
            </div>
          </header>
          {detail?.heightM != null ? (
            <p className="tb-phys">Scale {detail.heightM}m · mass {detail.weightKg}kg</p>
          ) : null}

          <label>
            Species
            <input
              value={current.species}
              onChange={event => {
                updateSet({ species: event.target.value });
                void search('species', 'species', event.target.value);
              }}
              onFocus={() => void search('species', 'species', current.species)}
            />
          </label>
          {suggestions?.field === 'species' ? <Suggestions results={suggestions.results} onPick={value => applySuggestion('species', value)} /> : null}

          <label>
            Held item
            <input
              value={current.item}
              onChange={event => {
                updateSet({ item: event.target.value });
                void search('item', 'item', event.target.value);
              }}
            />
          </label>
          {suggestions?.field === 'item' ? <Suggestions results={suggestions.results} onPick={value => applySuggestion('item', value)} /> : null}

          <label>
            Ability
            <input
              value={current.ability}
              onChange={event => {
                updateSet({ ability: event.target.value });
                void search('ability', 'ability', event.target.value);
              }}
              onFocus={() => void search('ability', 'ability', current.ability)}
            />
          </label>
          {suggestions?.field === 'ability' ? <Suggestions results={suggestions.results} onPick={value => applySuggestion('ability', value)} /> : null}

          <label>
            Tera type
            <select value={current.teraType} onChange={event => updateSet({ teraType: event.target.value })}>
              <option value="">None</option>
              {TERA_TYPES.map(type => <option key={type}>{type}</option>)}
            </select>
          </label>

          <div className="tb-moves">
            <header>
              <strong>Active move loadout</strong>
              <span>{current.moves.filter(move => move.trim()).length} / 4</span>
            </header>
            {current.moves.map((move, index) => {
              const field = `move-${index}` as SearchField;
              const info = detail?.moveDetails.find(item => item.name.toLowerCase() === move.trim().toLowerCase());
              return (
                <div key={index} className="tb-move">
                  <input
                    aria-label={`Move ${index + 1}`}
                    value={move}
                    onChange={event => {
                      updateMove(index, event.target.value);
                      void search(field, 'move', event.target.value);
                    }}
                  />
                  {suggestions?.field === field ? <Suggestions results={suggestions.results} onPick={value => applySuggestion(field, value)} /> : null}
                  {info ? (
                    <small>
                      {info.type || '—'} · {info.category || '—'} · {info.basePower ? `${info.basePower} BP` : 'Status'} · {info.accuracy == null ? '—' : `${info.accuracy}%`} · PP {info.pp}
                    </small>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="tb-stats">
          <header>
            <strong>Stat and EV calibration</strong>
            <span>{Math.max(0, 510 - evSpent)} / 510 EVs left</span>
          </header>
          <label>
            Nature
            <select value={current.nature} onChange={event => updateSet({ nature: event.target.value })}>
              {NATURES.map(nature => <option key={nature}>{nature}</option>)}
            </select>
          </label>
          <ul>
            {STATS.map(stat => {
              const row = detail?.stats.find(item => item.stat === stat.id);
              return (
                <li key={stat.id}>
                  <span>
                    {STAT_LABEL[stat.id]}
                    {row?.nature === 'up' ? ' +' : ''}
                    {row?.nature === 'down' ? ' −' : ''}
                    {row ? ` · base ${row.base}` : ''}
                  </span>
                  <input
                    aria-label={`${STAT_LABEL[stat.id]} EVs`}
                    inputMode="numeric"
                    value={current.evs[stat.id]}
                    onChange={event => updateEv(stat.id, event.target.value)}
                  />
                  <b>{row ? row.value : '—'}</b>
                </li>
              );
            })}
          </ul>
          <dl>
            <div><dt>Physical bulk</dt><dd>{detail?.physicalBulk?.toLocaleString('en-US') ?? '—'}</dd></div>
            <div><dt>Special bulk</dt><dd>{detail?.specialBulk?.toLocaleString('en-US') ?? '—'}</dd></div>
          </dl>
        </section>
      </div>

      <div className="tb-lower">
        <section>
          <h3>Team defensive profile</h3>
          {inspection?.threats.length ? (
            <ul>
              {inspection.threats.map(threat => (
                <li key={threat.attack}>
                  <strong>{threat.attack} {formatMultiplier(threat.worst)}</strong>
                  <span>Exposed: {threat.exposed.join(', ') || '—'}</span>
                  <span>Cover: {threat.covers.join(', ') || 'None'}</span>
                </li>
              ))}
            </ul>
          ) : <p>No 2× weaknesses on the sets that the dex recognizes.</p>}
        </section>
        <section>
          <h3>Speed ladder</h3>
          {inspection?.speeds.length ? (
            <ol>
              {inspection.speeds.map(entry => (
                <li key={entry.species}><span>{entry.species}</span><b>{entry.speed}</b></li>
              ))}
            </ol>
          ) : <p>Speed appears after a species resolves.</p>}
        </section>
      </div>
    </div>
  );
}

function Suggestions({ results, onPick }: { results: string[]; onPick: (value: string) => void }) {
  if (!results.length) return null;
  return (
    <div className="tb-suggest" role="listbox">
      {results.map(result => (
        <button key={result} type="button" onMouseDown={event => event.preventDefault()} onClick={() => onPick(result)}>
          {result}
        </button>
      ))}
    </div>
  );
}

function formatMultiplier(value: number): string {
  if (value === 0) return '0×';
  return `${value}×`;
}
