'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { PokemonIcon, PokemonSprite, TypeMark } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import { isDemoAuthEnabled } from '@/lib/demo-auth';
import type { TeamSearchHit } from '@/lib/protocol';
import {
  NATURES,
  STATS,
  TERA_TYPES,
  activateTeam,
  addBlankTeam,
  emptySet,
  natureLabel,
  readRoster,
  readSavedTeam,
  clearSavedTeam,
  setsFromInspection,
  setsToPaste,
  writeSavedTeam,
  type EditorSet,
  type SavedRoster,
  type StatId,
  type TeamInspection,
} from '@/lib/team';

type SearchField = `species` | `item` | `ability` | `move-${number}`;
type SearchKind = 'species' | 'move' | 'item' | 'ability';

interface SuggestionMenu {
  field: SearchField;
  kind: SearchKind;
  hits: TeamSearchHit[];
  scoped: boolean;
  hint?: string;
}

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
  const [name, setName] = useState('Demo Circuit');
  const [sets, setSets] = useState<EditorSet[]>(() => Array.from({ length: 6 }, emptySet));
  const [selected, setSelected] = useState(0);
  const [inspection, setInspection] = useState<TeamInspection | null>(null);
  const [notice, setNotice] = useState('Loading the Gen 9 OU validator.');
  const [importOpen, setImportOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionMenu | null>(null);
  const [knownMoves, setKnownMoves] = useState<Record<string, TeamSearchHit>>({});
  const [saved, setSaved] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [roster, setRoster] = useState<SavedRoster>({ activeId: '', teams: [] });
  const [hydrated, setHydrated] = useState(false);
  const inspectGeneration = useRef(0);
  const searchGeneration = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    async function load() {
      if (!playerId || !connected) {
        setNotice('Connect a wallet to edit and save a trainer-scoped team.');
        setHydrated(true);
        return;
      }
      const roster = readRoster(playerId);
      setRoster(roster);
      const stored = readSavedTeam(playerId);
      try {
        if (stored) {
          const message = await client.request({ type: 'team.inspect', team: stored.paste });
          if (cancelled || message.type !== 'team.inspect') return;
          setName(stored.name);
          setTeamId(stored.id);
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
  }, [client, playerId, connected]);

  useEffect(() => {
    if (!hydrated || !connected) return undefined;
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
    const requested = Math.max(0, Math.min(252, Number(raw) || 0));
    const others = STATS.reduce((sum, item) => sum + (item.id === stat ? 0 : (current.evs[item.id] || 0)), 0);
    const value = Math.min(requested, Math.max(0, 510 - others));
    updateSet({ evs: { ...current.evs, [stat]: value } });
  }

  function updateIv(stat: StatId, raw: string) {
    const value = Math.max(0, Math.min(31, Number(raw) || 0));
    updateSet({ ivs: { ...current.ivs, [stat]: value } });
  }

  function updateMove(slot: number, value: string) {
    const moves = [...current.moves] as EditorSet['moves'];
    moves[slot] = value;
    updateSet({ moves });
  }

  function rememberMoves(hits: TeamSearchHit[]) {
    setKnownMoves(current => {
      const next = { ...current };
      for (const hit of hits) next[hit.name.toLowerCase()] = hit;
      return next;
    });
  }

  async function search(field: SearchField, kind: SearchKind, query: string) {
    if (query.trim().length < 1 && kind !== 'ability' && !(kind === 'move' && current.species.trim())) {
      setSuggestions(kind === 'move'
        ? {
            field,
            kind,
            hits: [],
            scoped: false,
            hint: 'Choose a Pokémon first. This list will show only the attacks it can learn.',
          }
        : null);
      return;
    }
    const generation = ++searchGeneration.current;
    try {
      const message = await client.request({
        type: 'team.search',
        kind,
        query,
        ...( (kind === 'ability' || kind === 'move') && current.species.trim()
          ? { species: current.species.trim() }
          : {}),
      });
      if (generation !== searchGeneration.current || message.type !== 'team.search') return;
      const hits = message.hits?.length
        ? message.hits
        : message.results.map(name => ({ name }));
      if (kind === 'move') rememberMoves(hits);
      setSuggestions({
        field,
        kind,
        hits,
        scoped: Boolean(message.scoped),
        hint: hits.length ? undefined : 'Nothing matches that.',
      });
    } catch (error) {
      if (generation !== searchGeneration.current) return;
      const raw = error instanceof Error ? error.message : 'The list could not be loaded.';
      setSuggestions({
        field,
        kind,
        hits: [],
        scoped: false,
        hint: /authenticate|identify/i.test(raw)
          ? 'Connect your wallet to load this list.'
          : raw,
      });
    }
  }

  function applySuggestion(field: SearchField, value: string) {
    if (field === 'species') {
      void adoptSpecies(value);
    } else if (field === 'item') updateSet({ item: value });
    else if (field === 'ability') updateSet({ ability: value });
    else updateMove(Number(field.slice(5)), value);
    setSuggestions(null);
  }

  async function adoptSpecies(species: string) {
    const slot = selected;
    setSuggestions(null);
    setSaved(false);
    try {
      const [abilities, moves] = await Promise.all([
        client.request({ type: 'team.search', kind: 'ability', query: '', species }),
        client.request({ type: 'team.search', kind: 'move', query: '', species }),
      ]);
      const abilityNames = abilities.type === 'team.search' ? abilities.results : [];
      const moveNames = moves.type === 'team.search' ? moves.results : [];
      if (moves.type === 'team.search' && moves.hits?.length) rememberMoves(moves.hits);
      const legal = new Set(moveNames.map(move => move.toLowerCase()));
      setSets(existing => existing.map((set, index) => {
        if (index !== slot) return set;
        const keptAbility = abilityNames.some(name => name.toLowerCase() === set.ability.trim().toLowerCase())
          ? set.ability
          : (abilityNames[0] ?? '');
        return {
          ...set,
          species,
          ability: keptAbility,
          moves: set.moves.map(move => (
            move.trim() && legal.size && !legal.has(move.trim().toLowerCase()) ? '' : move
          )) as EditorSet['moves'],
        };
      }));
    } catch {
      updateSet({ species });
    }
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

  function blankEditor(nextName: string) {
    setName(nextName);
    setSets(Array.from({ length: 6 }, emptySet));
    setSelected(0);
    setPaste('');
    setInspection(null);
    setSuggestions(null);
    setImportOpen(false);
    setSaved(false);
  }

  function snapshotTeam(id: string) {
    return {
      id,
      name: name.trim() || 'Untitled',
      paste: setsToPaste(sets),
      species: sets.map(set => set.species.trim()).filter(Boolean),
      validated: Boolean(inspection?.packed),
    };
  }

  async function loadPaste(nextName: string, nextPaste: string, id: string) {
    setTeamId(id);
    setName(nextName);
    setPaste(nextPaste);
    setSuggestions(null);
    setSaved(true);
    if (!nextPaste.trim()) {
      blankEditor(nextName);
      setTeamId(id);
      return;
    }
    const message = await client.request({ type: 'team.inspect', team: nextPaste });
    if (message.type !== 'team.inspect') return;
    setSets(setsFromInspection(message.inspection));
    setInspection(message.inspection);
    setSelected(0);
    setNotice(message.inspection.packed ? 'Saved team passes Gen 9 OU.' : 'Saved draft still has clause problems.');
  }

  async function switchTeam(id: string) {
    if (!playerId || id === teamId) return;
    writeSavedTeam(playerId, snapshotTeam(teamId || `team-${Date.now().toString(36)}`));
    activateTeam(playerId, id);
    const next = readRoster(playerId);
    setRoster(next);
    const team = next.teams.find(item => item.id === id);
    if (!team) return;
    await loadPaste(team.name, team.paste, team.id);
  }

  function startNewTeam() {
    if (playerId) {
      const currentId = teamId || `team-${Date.now().toString(36)}`;
      writeSavedTeam(playerId, snapshotTeam(currentId));
      const created = addBlankTeam(playerId);
      setRoster(readRoster(playerId));
      setTeamId(created.id);
    }
    blankEditor('New team');
    setNotice('Blank team. Choose a species in slot 1.');
  }

  function clearTeam() {
    const occupied = sets.some(set => set.species.trim());
    if (occupied && !window.confirm('Clear this team and start from scratch?')) return;
    blankEditor('New team');
    if (playerId) clearSavedTeam(playerId);
    if (playerId) setRoster(readRoster(playerId));
    setNotice('Blank team. Choose a species in slot 1.');
  }

  function save() {
    if (!playerId) {
      setNotice('Connect a wallet before saving a team.');
      return;
    }
    const id = teamId || `team-${Date.now().toString(36)}`;
    writeSavedTeam(playerId, snapshotTeam(id));
    setTeamId(id);
    setRoster(readRoster(playerId));
    setSaved(true);
    setNotice(inspection?.packed
      ? 'Saved on this browser. Ready up or register to bring this team.'
      : isDemoAuthEnabled()
        ? 'Draft saved. It does not pass Gen 9 OU, so a match will bring the demo team.'
        : 'Draft saved. It does not pass Gen 9 OU, so it cannot be locked for a match.');
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
          {roster.teams.length > 1 ? (
            <select aria-label="Saved teams" value={teamId} onChange={event => void switchTeam(event.target.value)}>
              {roster.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          ) : null}
          <button type="button" onClick={startNewTeam}>New team</button>
          <button type="button" onClick={() => {
            setPaste(setsToPaste(sets));
            setImportOpen(open => !open);
          }}>Import / export</button>
          <button type="button" onClick={clearTeam}>Clear team</button>
          <button type="button" className="primary" onClick={save}>{saved ? 'Saved' : 'Save team'}</button>
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
              placeholder="Type a Pokémon name"
              onChange={event => {
                updateSet({ species: event.target.value });
                void search('species', 'species', event.target.value);
              }}
              onFocus={() => void search('species', 'species', current.species)}
            />
          </label>
          {suggestions?.field === 'species' ? <Suggestions menu={suggestions} onPick={value => applySuggestion('species', value)} /> : null}

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
          {suggestions?.field === 'item' ? <Suggestions menu={suggestions} onPick={value => applySuggestion('item', value)} /> : null}

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
          {suggestions?.field === 'ability' ? <Suggestions menu={suggestions} onPick={value => applySuggestion('ability', value)} /> : null}
          {detail?.abilities?.length ? (
            <div className="tb-choices">
              {detail.abilities.map(ability => (
                <button
                  key={ability}
                  type="button"
                  className={ability.toLowerCase() === current.ability.trim().toLowerCase() ? 'active' : ''}
                  onClick={() => updateSet({ ability })}
                >
                  {ability}
                </button>
              ))}
            </div>
          ) : null}

          <label>
            Tera type
            <select value={current.teraType} onChange={event => updateSet({ teraType: event.target.value })}>
              <option value="">None</option>
              {TERA_TYPES.map(type => <option key={type}>{type}</option>)}
            </select>
          </label>

          <div className="tb-moves">
            <header>
              <strong>Attacks</strong>
              <span>{current.moves.filter(move => move.trim()).length} / 4</span>
            </header>
            <ul className="tb-attack-key">
              <li><span className="tb-cat is-physical">Physical</span><span>Attack vs Defense</span></li>
              <li><span className="tb-cat is-special">Special</span><span>Sp. Atk vs Sp. Def</span></li>
              <li><span className="tb-cat is-status">Status</span><span>No direct damage</span></li>
            </ul>
            {current.moves.map((move, index) => {
              const field = `move-${index}` as SearchField;
              const fact = moveFact(move, knownMoves, detail?.moveDetails);
              return (
                <div key={index} className="tb-move">
                  <input
                    aria-label={`Move ${index + 1}`}
                    placeholder={current.species.trim() ? 'Search this Pokémon’s attacks' : 'Attack name'}
                    value={move}
                    onChange={event => {
                      updateMove(index, event.target.value);
                      void search(field, 'move', event.target.value);
                    }}
                    onFocus={() => void search(field, 'move', move)}
                  />
                  {suggestions?.field === field ? (
                    <Suggestions
                      menu={suggestions}
                      onPick={value => applySuggestion(field, value)}
                    />
                  ) : fact ? <AttackCard hit={fact} /> : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="tb-stats">
          <header>
            <strong>Stat and EV calibration</strong>
            <span>{510 - evSpent} / 510 EVs left</span>
          </header>
          <label>
            Nature
            <select value={current.nature} onChange={event => updateSet({ nature: event.target.value })}>
              {NATURES.map(nature => <option key={nature} value={nature}>{natureLabel(nature)}</option>)}
            </select>
          </label>
          <ul>
            <li className="tb-stat-head">
              <span>Stat</span>
              <span>EV</span>
              <span>IV</span>
              <b>Final</b>
            </li>
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
                  <input
                    aria-label={`${STAT_LABEL[stat.id]} IVs`}
                    inputMode="numeric"
                    value={current.ivs[stat.id]}
                    onChange={event => updateIv(stat.id, event.target.value)}
                  />
                  <b>{row ? row.value : '—'}</b>
                </li>
              );
            })}
          </ul>
          <p className="tb-spread">
            {natureLabel(current.nature)} · {STATS.filter(stat => current.evs[stat.id] > 0).map(stat => `${current.evs[stat.id]} ${STAT_LABEL[stat.id]}`).join(' / ') || 'No EVs'}
          </p>
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
          {inspection?.benchmarks?.length ? (
            <ul className="tb-benchmarks">
              {inspection.benchmarks.map(mark => (
                <li key={mark.label}><span>{mark.label}</span><b>{mark.speed}</b></li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function Suggestions({ menu, onPick }: { menu: SuggestionMenu; onPick: (value: string) => void }) {
  const title = menu.kind === 'move'
    ? (menu.scoped ? 'Attacks this Pokémon can learn' : 'Matching attacks')
    : menu.kind === 'species'
      ? 'Pokémon'
      : menu.kind === 'ability'
        ? (menu.scoped ? 'Abilities this Pokémon can have' : 'Matching abilities')
        : 'Matching items';
  return (
    <div className="tb-suggest" role="listbox" aria-label={title}>
      <p className="tb-plain">{title}</p>
      {menu.hint ? <p className="tb-plain">{menu.hint}</p> : null}
      {menu.hits.map(hit => (
        <button
          key={hit.name}
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={() => onPick(hit.name)}
        >
          {menu.kind === 'species' ? <SpeciesHit hit={hit} /> : menu.kind === 'move' ? <AttackCard hit={hit} showName /> : <HitBody hit={hit} />}
        </button>
      ))}
    </div>
  );
}

function SpeciesHit({ hit }: { hit: TeamSearchHit }) {
  return (
    <span className="tb-hit-row">
      <PokemonIcon name={hit.name} />
      <span>
        <span className="tb-hit-name">{hit.name}</span>
        {hit.types?.length ? (
          <span className="tb-hit-meta">
            {hit.types.map(type => (
              <span key={type}><TypeMark type={type} />{type}</span>
            ))}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function HitBody({ hit }: { hit: TeamSearchHit }) {
  return (
    <span className="tb-hit-copy">
      <span className="tb-hit-name">{hit.name}</span>
      {hit.description ? <span className="tb-hit-desc">{hit.description}</span> : null}
    </span>
  );
}

function AttackCard({ hit, showName = false }: { hit: TeamSearchHit; showName?: boolean }) {
  const category = hit.category?.toLowerCase();
  const power = hit.category === 'Status' ? '—' : hit.power ? String(hit.power) : 'Var';
  const accuracy = hit.accuracy == null ? 'Always' : `${hit.accuracy}%`;
  const pp = hit.pp != null ? String(hit.pp) : '—';
  return (
    <span className="tb-attack">
      <span className="tb-attack-top">
        {showName ? (
          <span className="tb-hit-name">
            {hit.type ? <TypeMark type={hit.type} /> : null}
            {hit.name}
          </span>
        ) : hit.type ? (
          <span className="tb-type-chip"><TypeMark type={hit.type} /></span>
        ) : <span />}
        {category ? <span className={`tb-cat is-${category}`}>{hit.category}</span> : null}
      </span>
      <span className="tb-attack-stats">
        <span><b>{power}</b><small>Power</small></span>
        <span><b>{accuracy}</b><small>{hit.accuracy == null ? 'Hits' : 'Acc'}</small></span>
        <span><b>{pp}</b><small>PP</small></span>
      </span>
      {hit.description ? <span className="tb-hit-desc">{hit.description}</span> : null}
    </span>
  );
}

function moveFact(
  name: string,
  known: Record<string, TeamSearchHit>,
  inspected: { name: string; type: string; category: string; basePower: number; accuracy: number | null; pp: number; description?: string }[] | undefined,
): TeamSearchHit | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const remembered = known[trimmed.toLowerCase()];
  if (remembered) return remembered;
  const info = inspected?.find(item => item.name.toLowerCase() === trimmed.toLowerCase());
  if (!info) return null;
  return {
    name: info.name,
    type: info.type,
    category: info.category,
    power: info.basePower,
    accuracy: info.accuracy,
    pp: info.pp,
    description: info.description,
  };
}

function formatMultiplier(value: number): string {
  if (value === 0) return '0×';
  return `${value}×`;
}
