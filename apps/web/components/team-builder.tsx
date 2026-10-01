'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { PokemonIcon, PokemonSprite, TypeMark } from '@/components/showdown-visuals';
import { useArena } from '@/lib/arena-context';
import {
  customFormats,
  formatById,
  formatBuilderBlurb,
  formatLabel,
} from '@/lib/tournament-formats';
import type { TeamSearchHit } from '@/lib/protocol';
import {
  NATURES,
  STATS,
  TERA_TYPES,
  activateTeam,
  addBlankTeam,
  emptySet,
  evsAreUntouched,
  fillMoveSlots,
  natureLabel,
  pickStarterEvs,
  pickStarterMoves,
  pickStarterNature,
  readRoster,
  readSavedTeam,
  clearSavedTeam,
  classifyTeamProblems,
  filterItemHits,
  filterMoveHits,
  filterSpeciesHits,
  setsFromInspection,
  setsToPaste,
  sortMoveHits,
  teamLegalityTone,
  visibleTeamProblems,
  writeSavedTeam,
  type EditorSet,
  type MoveSort,
  type SavedRoster,
  type StatId,
  type TeamInspection,
} from '@/lib/team';

type Picker =
  | { kind: 'species'; slot: number }
  | { kind: 'item'; slot: number }
  | { kind: 'move'; slot: number; moveSlot: number }
  | { kind: 'import' };

const STAT_LABEL: Record<StatId, string> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spa: 'SpA',
  spd: 'SpD',
  spe: 'Spe',
};

const MOVE_CATEGORIES = ['Physical', 'Special', 'Status'] as const;
const MOVE_SORTS: { id: MoveSort; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'power', label: 'Power' },
  { id: 'accuracy', label: 'Accuracy' },
  { id: 'type', label: 'Type' },
];

export function TeamBuilder({
  initialRulesetId = 'gen9ou',
  tournamentId,
  formatLocked = false,
}: {
  initialRulesetId?: string;
  tournamentId?: string;
  formatLocked?: boolean;
}) {
  const { client, playerId, connected } = useArena();
  const [rulesetId, setRulesetId] = useState(initialRulesetId);
  const formatCard = formatById(rulesetId);
  const formatName = formatLabel(rulesetId);
  const formatBlurb = formatBuilderBlurb(rulesetId);
  const builderFormats = useMemo(() => customFormats(), []);
  const preserveDraftOnRulesetChange = useRef(false);
  const [name, setName] = useState('Demo Circuit');
  const [sets, setSets] = useState<EditorSet[]>(() => Array.from({ length: 6 }, emptySet));
  const [selected, setSelected] = useState(0);
  const [inspection, setInspection] = useState<TeamInspection | null>(null);
  const [notice, setNotice] = useState(`Loading the ${formatName} validator.`);
  const [paste, setPaste] = useState('');
  const [knownMoves, setKnownMoves] = useState<Record<string, TeamSearchHit>>({});
  const [saved, setSaved] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [roster, setRoster] = useState<SavedRoster>({ activeId: '', teams: [] });
  const [hydrated, setHydrated] = useState(false);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [pickerQuery, setPickerQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [moveSort, setMoveSort] = useState<MoveSort>('name');
  const [speciesCatalog, setSpeciesCatalog] = useState<TeamSearchHit[] | null>(null);
  const [itemCatalog, setItemCatalog] = useState<{ species: string; hits: TeamSearchHit[] } | null>(null);
  const [learnset, setLearnset] = useState<TeamSearchHit[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(true);
  const inspectGeneration = useRef(0);
  const catalogGeneration = useRef(0);
  const speciesGeneration = useRef(0);

  useEffect(() => {
    setRulesetId(initialRulesetId);
  }, [initialRulesetId]);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    async function load() {
      if (preserveDraftOnRulesetChange.current) {
        preserveDraftOnRulesetChange.current = false;
        if (playerId) setRoster(readRoster(playerId, rulesetId));
        setSpeciesCatalog(null);
        setItemCatalog(null);
        setLearnset([]);
        setKnownMoves({});
        setHydrated(true);
        return;
      }
      if (!playerId || !connected) {
        setNotice('Connect a wallet to edit and save a trainer-scoped team.');
        setHydrated(true);
        return;
      }
      const nextRoster = readRoster(playerId, rulesetId);
      setRoster(nextRoster);
      const stored = readSavedTeam(playerId, rulesetId);
      try {
        if (stored) {
          if (!stored.paste.trim()) {
            setName(stored.name);
            setTeamId(stored.id);
            setSets(Array.from({ length: 6 }, emptySet));
            setInspection(null);
            setPaste('');
            setNotice(`Pick Pokémon legal in ${formatName}.`);
            setSaved(true);
            setHydrated(true);
            return;
          }
          const message = await client.request({ type: 'team.inspect', team: stored.paste, ruleset: rulesetId });
          if (cancelled || message.type !== 'team.inspect') return;
          setName(stored.name);
          setTeamId(stored.id);
          setSets(setsFromInspection(message.inspection));
          setInspection(message.inspection);
          setPaste(stored.paste);
          setNotice(message.inspection.packed ? `Saved team passes ${formatName}.` : 'Saved draft still has clause problems.');
          setSaved(true);
          setHydrated(true);
          return;
        }
        if (rulesetId !== 'gen9ou') {
          if (cancelled) return;
          const blankId = `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          setTeamId(blankId);
          setName(`${formatName} team`);
          setSets(Array.from({ length: 6 }, emptySet));
          setInspection(null);
          setPaste('');
          setNotice(`Pick Pokémon legal in ${formatName}.`);
          setHydrated(true);
          return;
        }
        const starter = await client.request({ type: 'team.starter' });
        if (cancelled || starter.type !== 'team.starter') return;
        const message = await client.request({ type: 'team.inspect', team: starter.paste, ruleset: rulesetId });
        if (cancelled || message.type !== 'team.inspect') return;
        setName(starter.name);
        setSets(setsFromInspection(message.inspection));
        setInspection(message.inspection);
        setPaste(starter.paste);
        setNotice(`Starter team passes ${formatName}. Edit a slot, then save.`);
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
  }, [client, playerId, connected, rulesetId, formatName]);

  useEffect(() => {
    if (!hydrated || !connected) return undefined;
    const generation = ++inspectGeneration.current;
    const handle = window.setTimeout(() => {
      const nextPaste = setsToPaste(sets);
      if (!nextPaste.trim()) {
        if (generation === inspectGeneration.current) setInspection(null);
        return;
      }
      void client.request({ type: 'team.inspect', team: nextPaste, ruleset: rulesetId }).then(message => {
        if (generation !== inspectGeneration.current) return;
        if (message.type === 'team.inspect') setInspection(message.inspection);
      }).catch(error => {
        if (generation !== inspectGeneration.current) return;
        setNotice(error instanceof Error ? error.message : 'Validator unavailable.');
      });
    }, 280);
    return () => window.clearTimeout(handle);
  }, [client, connected, hydrated, sets, rulesetId]);

  const current = sets[selected] ?? emptySet();
  const pickerSet = picker && picker.kind !== 'import'
    ? sets[picker.slot] ?? emptySet()
    : current;
  const detail = useMemo(() => {
    if (!inspection || !current.species.trim()) return undefined;
    const position = sets.slice(0, selected + 1).filter(set => set.species.trim()).length - 1;
    return inspection.sets[position];
  }, [current.species, inspection, selected, sets]);

  const evSpent = STATS.reduce((sum, stat) => sum + (current.evs[stat.id] || 0), 0);

  const filteredSpecies = useMemo(() => {
    return filterSpeciesHits(speciesCatalog ?? [], pickerQuery, typeFilter);
  }, [pickerQuery, speciesCatalog, typeFilter]);

  const filteredItems = useMemo(() => {
    return filterItemHits(itemCatalog?.hits ?? [], pickerQuery);
  }, [itemCatalog, pickerQuery]);
  const builderProblems = useMemo(() => (
    inspection ? visibleTeamProblems(inspection.problems) : []
  ), [inspection]);
  const problemGroups = useMemo(() => classifyTeamProblems(builderProblems), [builderProblems]);
  const filledSlots = sets.filter(set => set.species.trim()).length;
  const legalityTone = teamLegalityTone(filledSlots, inspection?.packed, builderProblems);

  const filteredMoves = useMemo(() => {
    return sortMoveHits(filterMoveHits(learnset, pickerQuery, typeFilter, categoryFilter), moveSort);
  }, [categoryFilter, learnset, moveSort, pickerQuery, typeFilter]);

  function switchFormat(nextId: string) {
    if (nextId === rulesetId || formatLocked) return;
    if (!formatById(nextId)) return;
    preserveDraftOnRulesetChange.current = true;
    closePicker();
    setSpeciesCatalog(null);
    setItemCatalog(null);
    setLearnset([]);
    setKnownMoves({});
    setInspection(null);
    setSaved(false);
    setShowIssues(true);
    setRulesetId(nextId);
    const nextLabel = formatLabel(nextId);
    const filled = sets.filter(set => set.species.trim()).length;
    setNotice(filled
      ? `Switched to ${nextLabel}. Revalidating the current team — illegal pieces stay marked until you change them.`
      : `Building for ${nextLabel}. ${formatBuilderBlurb(nextId)}`);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('ruleset', nextId);
      window.history.replaceState({}, '', `${url.pathname}${url.search}`);
    }
  }

  function updateSet(patch: Partial<EditorSet>) {
    updateSetAt(selected, patch);
  }

  function updateSetAt(slot: number, patch: Partial<EditorSet>) {
    setSaved(false);
    setSets(existing => existing.map((set, index) => index === slot ? { ...set, ...patch } : set));
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

  function updateMoveAt(targetSlot: number, moveSlot: number, value: string) {
    setSaved(false);
    setSets(existing => existing.map((set, index) => {
      if (index !== targetSlot) return set;
      const moves = [...set.moves] as EditorSet['moves'];
      moves[moveSlot] = value;
      return { ...set, moves };
    }));
  }

  function rememberMoves(hits: TeamSearchHit[]) {
    setKnownMoves(current => {
      const next = { ...current };
      for (const hit of hits) next[hit.name.toLowerCase()] = hit;
      return next;
    });
  }

  function closePicker() {
    catalogGeneration.current += 1;
    setPicker(null);
    setPickerQuery('');
    setTypeFilter('');
    setCategoryFilter('');
    setMoveSort('name');
    setPickerError(null);
  }

  async function openSpeciesPicker(slot = selected) {
    setSelected(slot);
    setPicker({ kind: 'species', slot });
    setPickerQuery('');
    setTypeFilter('');
    setPickerError(null);
    const generation = ++catalogGeneration.current;
    if (speciesCatalog) {
      setCatalogBusy(false);
      return;
    }
    setCatalogBusy(true);
    try {
      const message = await client.request({ type: 'team.search', kind: 'species', query: '', ruleset: rulesetId });
      if (generation !== catalogGeneration.current) return;
      if (message.type === 'team.search') {
        setSpeciesCatalog(message.hits ?? message.results.map(name => ({ name })));
      }
    } catch (error) {
      if (generation === catalogGeneration.current) {
        setPickerError(error instanceof Error ? error.message : 'Pokédex unavailable.');
      }
    } finally {
      if (generation === catalogGeneration.current) setCatalogBusy(false);
    }
  }

  async function openItemPicker(slot = selected) {
    const target = sets[slot] ?? emptySet();
    const species = target.species.trim();
    if (!species) {
      setNotice('Choose a Pokémon before picking an item.');
      return;
    }
    setPicker({ kind: 'item', slot });
    setPickerQuery('');
    setPickerError(null);
    const generation = ++catalogGeneration.current;
    if (itemCatalog && itemCatalog.species.toLowerCase() === species.toLowerCase()) {
      setCatalogBusy(false);
      return;
    }
    setItemCatalog(null);
    setCatalogBusy(true);
    try {
      const message = await client.request({ type: 'team.search', kind: 'item', query: '', species, ruleset: rulesetId });
      if (generation !== catalogGeneration.current) return;
      if (message.type === 'team.search') {
        setItemCatalog({
          species,
          hits: message.hits?.length ? message.hits : message.results.map(name => ({ name })),
        });
      }
    } catch (error) {
      if (generation === catalogGeneration.current) {
        setPickerError(error instanceof Error ? error.message : 'Item list unavailable.');
      }
    } finally {
      if (generation === catalogGeneration.current) setCatalogBusy(false);
    }
  }

  async function openMovePicker(moveSlot: number, slot = selected) {
    const target = sets[slot] ?? emptySet();
    if (!target.species.trim()) {
      setNotice('Choose a Pokémon before picking attacks.');
      return;
    }
    setPicker({ kind: 'move', slot, moveSlot });
    setPickerQuery('');
    setTypeFilter('');
    setCategoryFilter('');
    setMoveSort('name');
    setPickerError(null);
    setLearnset([]);
    const generation = ++catalogGeneration.current;
    setCatalogBusy(true);
    try {
      const message = await client.request({
        type: 'team.search',
        kind: 'move',
        query: '',
        species: target.species.trim(),
        ruleset: rulesetId,
      });
      if (generation !== catalogGeneration.current) return;
      if (message.type === 'team.search') {
        const hits = message.hits?.length ? message.hits : message.results.map(name => ({ name }));
        setLearnset(hits);
        rememberMoves(hits);
      }
    } catch (error) {
      if (generation === catalogGeneration.current) {
        setPickerError(error instanceof Error ? error.message : 'Move list unavailable.');
      }
    } finally {
      if (generation === catalogGeneration.current) setCatalogBusy(false);
    }
  }

  async function adoptSpecies(species: string, types: string[] = []) {
    const slot = picker?.kind === 'species' ? picker.slot : selected;
    const generation = ++speciesGeneration.current;
    const speciesTypes = types.length
      ? types
      : (speciesCatalog ?? []).find(hit => hit.name === species)?.types ?? [];
    setSaved(false);
    closePicker();
    try {
      const [abilities, moves, items] = await Promise.all([
        client.request({ type: 'team.search', kind: 'ability', query: '', species, ruleset: rulesetId }),
        client.request({ type: 'team.search', kind: 'move', query: '', species, ruleset: rulesetId }),
        client.request({ type: 'team.search', kind: 'item', query: '', species, ruleset: rulesetId }),
      ]);
      if (generation !== speciesGeneration.current) return;
      const abilityNames = abilities.type === 'team.search' ? abilities.results : [];
      const moveHits = moves.type === 'team.search'
        ? (moves.hits?.length ? moves.hits : moves.results.map(name => ({ name })))
        : [];
      const itemNames = items.type === 'team.search' ? items.results : [];
      if (moveHits.length) {
        rememberMoves(moveHits);
        setLearnset(moveHits);
      }
      if (items.type === 'team.search') {
        setItemCatalog({
          species,
          hits: items.hits?.length ? items.hits : items.results.map(name => ({ name })),
        });
      }
      const legal = new Set(moveHits.map(hit => hit.name.toLowerCase()));
      const starterMoves = pickStarterMoves(moveHits, speciesTypes);
      setSets(existing => existing.map((set, index) => {
        if (index !== slot) return set;
        const keptAbility = abilityNames.some(name => name.toLowerCase() === set.ability.trim().toLowerCase())
          ? set.ability
          : (abilityNames[0] ?? '');
        const keptItem = itemNames.some(name => name.toLowerCase() === set.item.trim().toLowerCase())
          ? set.item
          : '';
        const keptMoves = set.moves.map(move => (
          move.trim() && legal.size && !legal.has(move.trim().toLowerCase()) ? '' : move
        ));
        const moves = fillMoveSlots(keptMoves, starterMoves);
        const evs = evsAreUntouched(set.evs) ? pickStarterEvs(moves, moveHits) : set.evs;
        return {
          ...emptySet(),
          species,
          ability: keptAbility,
          teraType: set.teraType || speciesTypes[0] || '',
          nature: evsAreUntouched(set.evs) ? pickStarterNature(evs, set.nature) : (set.nature || 'Serious'),
          evs,
          ivs: set.ivs,
          item: keptItem,
          moves,
        };
      }));
    } catch (error) {
      if (generation !== speciesGeneration.current) return;
      updateSetAt(slot, { species });
      setNotice(error instanceof Error ? error.message : 'Pokémon details unavailable.');
    }
  }

  async function applyPaste() {
    try {
      const message = await client.request({ type: 'team.inspect', team: paste, ruleset: rulesetId });
      if (message.type !== 'team.inspect') return;
      setSets(setsFromInspection(message.inspection));
      setInspection(message.inspection);
      setSelected(0);
      setSaved(false);
      closePicker();
      setNotice(message.inspection.packed ? `Imported paste passes ${formatName}.` : 'Imported paste still has clause problems.');
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
    closePicker();
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
    closePicker();
    setSaved(true);
    if (!nextPaste.trim()) {
      blankEditor(nextName);
      setTeamId(id);
      return;
    }
    const message = await client.request({ type: 'team.inspect', team: nextPaste, ruleset: rulesetId });
    if (message.type !== 'team.inspect') return;
    setSets(setsFromInspection(message.inspection));
    setInspection(message.inspection);
    setSelected(0);
    setNotice(message.inspection.packed ? `Saved team passes ${formatName}.` : 'Saved draft still has clause problems.');
  }

  async function switchTeam(id: string) {
    if (!playerId || id === teamId) return;
    writeSavedTeam(playerId, snapshotTeam(teamId || `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`), rulesetId);
    activateTeam(playerId, id, rulesetId);
    const next = readRoster(playerId, rulesetId);
    setRoster(next);
    const team = next.teams.find(item => item.id === id);
    if (!team) return;
    await loadPaste(team.name, team.paste, team.id);
  }

  function startNewTeam() {
    if (playerId) {
      const currentId = teamId || `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      writeSavedTeam(playerId, snapshotTeam(currentId), rulesetId);
      const created = addBlankTeam(playerId, rulesetId);
      setRoster(readRoster(playerId, rulesetId));
      setTeamId(created.id);
    }
    blankEditor('New team');
    setNotice('Blank team. Choose a Pokémon in slot 1.');
  }

  function clearTeam() {
    const occupied = sets.some(set => set.species.trim());
    if (occupied && !window.confirm('Clear this team and start from scratch?')) return;
    blankEditor('New team');
    if (playerId) clearSavedTeam(playerId, rulesetId);
    if (playerId) setRoster(readRoster(playerId, rulesetId));
    setNotice('Blank team. Choose a Pokémon in slot 1.');
  }

  async function save() {
    if (!playerId) {
      setNotice('Connect a wallet before saving a team.');
      return;
    }
    const id = teamId || `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot = snapshotTeam(id);
    writeSavedTeam(playerId, snapshot, rulesetId);
    setTeamId(id);
    setRoster(readRoster(playerId, rulesetId));
    setSaved(true);
    if (tournamentId && snapshot.validated) {
      try {
        await client.request({
          type: 'tournament.updateTeam',
          tournamentId,
          team: snapshot.paste,
        });
        setNotice(`Saved for ${formatName}. The tournament entry was updated.`);
        return;
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    setNotice(snapshot.validated
      ? `Saved for ${formatName}. It is ready when that cup opens.`
      : `Draft saved. It does not pass ${formatName}, so it cannot enter that cup.`);
  }

  function openImport() {
    catalogGeneration.current += 1;
    setPaste(setsToPaste(sets));
    setPickerError(null);
    setCatalogBusy(false);
    setPicker({ kind: 'import' });
  }

  return (
    <div className="pa-page tb">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1>Team builder</h1>
          <p className="pa-lead">Choose a format first. The Pokédex, moves, abilities, and items follow that ruleset.</p>
        </div>
        <div className="tb-file-actions">
          <label className="tb-name">
            Team name
            <input aria-label="Team name" value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
          </label>
          {roster.teams.length > 1 ? (
            <select aria-label="Saved teams" value={teamId} onChange={event => void switchTeam(event.target.value)}>
              {roster.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          ) : null}
          <button type="button" className="pa-btn pa-btn-surface pa-btn-sm" onClick={startNewTeam}>New</button>
          <button type="button" className="pa-btn pa-btn-surface pa-btn-sm" onClick={openImport}>Import / export</button>
          <button type="button" className="pa-btn pa-btn-surface pa-btn-sm" onClick={clearTeam}>Clear</button>
          <button type="button" className="pa-btn pa-btn-primary pa-btn-sm" onClick={() => void save()}>{saved ? 'Saved' : 'Save team'}</button>
        </div>
      </header>

      <section className={`tb-format ${formatLocked ? 'is-locked' : ''}`} aria-label="Team format">
        <div className="tb-format-copy">
          <small>Team format</small>
          <strong>{formatName}</strong>
          <p>{formatBlurb}</p>
          {formatLocked ? (
            <em>Locked for this tournament entry. Finish this format team, then return to the cup.</em>
          ) : (
            <em>Changing format rechecks this team. Illegal pieces stay until you replace them.</em>
          )}
        </div>
        <label className="tb-format-select">
          <span>Format</span>
          <select
            aria-label="Team format"
            value={rulesetId}
            disabled={formatLocked}
            onChange={event => switchFormat(event.target.value)}
          >
            {builderFormats.map(format => (
              <option key={format.id} value={format.id}>
                {format.title}
                {format.id === 'gen9ou' ? ' · SV OU' : ` · Gen ${format.generation} only`}
              </option>
            ))}
          </select>
        </label>
        {!formatLocked ? (
          <div className="tb-format-chips">
            {builderFormats.map(format => (
              <button
                key={format.id}
                type="button"
                className={format.id === rulesetId ? 'active' : ''}
                aria-pressed={format.id === rulesetId}
                onClick={() => switchFormat(format.id)}
              >
                {format.id === 'gen9ou' ? 'Gen 9 OU' : `Gen ${format.generation}`}
              </button>
            ))}
          </div>
        ) : null}
      </section>

      <section className={`tb-legality tone-${legalityTone}`} aria-label="Team status">
        <header>
          <small>Team status</small>
          <strong>
            {legalityTone === 'legal' ? 'Legal'
              : legalityTone === 'empty' ? 'Empty'
                : legalityTone === 'needs-changes' ? 'Team needs changes'
                  : 'Illegal'}
          </strong>
          <span>{formatCard?.restriction ?? formatName}</span>
        </header>
        <ul>
          <li className={filledSlots === 6 ? 'ok' : 'warn'}>
            {filledSlots === 6 ? '✓' : '⚠'} {filledSlots}/6 Pokémon
          </li>
          <li className={problemGroups.pokemon.length || (inspection && !inspection.packed && filledSlots) ? (problemGroups.pokemon.length ? 'bad' : (inspection?.packed ? 'ok' : 'warn')) : (filledSlots ? 'ok' : 'muted')}>
            {problemGroups.pokemon.length
              ? `✕ ${problemGroups.pokemon.length} Pokémon not Gen-legal for ${formatName}`
              : inspection?.packed
                ? '✓ All Pokémon legal'
                : filledSlots
                  ? '⚠ Checking Pokémon legality'
                  : '— No Pokémon yet'}
          </li>
          <li className={problemGroups.moves.length ? 'bad' : (inspection?.packed ? 'ok' : 'muted')}>
            {problemGroups.moves.length
              ? `✕ ${problemGroups.moves.length} move issue${problemGroups.moves.length === 1 ? '' : 's'}`
              : inspection?.packed ? '✓ All moves legal' : '— Moves checked with the format'}
          </li>
          <li className={problemGroups.abilities.length ? 'bad' : (inspection?.packed ? 'ok' : 'muted')}>
            {problemGroups.abilities.length
              ? `✕ ${problemGroups.abilities.length} ability issue${problemGroups.abilities.length === 1 ? '' : 's'}`
              : inspection?.packed ? '✓ All abilities legal' : '— Abilities checked with the format'}
          </li>
          <li className={problemGroups.items.length ? 'bad' : (inspection?.packed ? 'ok' : 'muted')}>
            {problemGroups.items.length
              ? `✕ ${problemGroups.items.length} item issue${problemGroups.items.length === 1 ? '' : 's'}`
              : inspection?.packed ? '✓ All items legal' : '— Items checked with the format'}
          </li>
        </ul>
        {builderProblems.length ? (
          <div className="tb-legality-actions">
            <button type="button" className="pa-btn pa-btn-surface pa-btn-sm" onClick={() => setShowIssues(value => !value)}>
              {showIssues ? 'Hide issues' : `View issues (${builderProblems.length})`}
            </button>
          </div>
        ) : null}
      </section>

      <p className={`tb-status ${inspection?.packed ? 'ok' : ''}`}>
        {connected ? notice : 'Connecting to the validator…'}
        {inspection?.packed ? ' · Ready for this format' : ''}
      </p>

      {showIssues && builderProblems.length ? (
        <ul className="tb-problems">
          {builderProblems.slice(0, 8).map(problem => <li key={problem}>{problem}</li>)}
        </ul>
      ) : null}

      <div className="tb-grid">
        <aside className="tb-slots">
          {sets.map((set, index) => {
            const empty = !set.species.trim();
            const slotIllegal = Boolean(
              set.species.trim()
              && builderProblems.some(problem => problem.toLowerCase().includes(set.species.trim().toLowerCase())),
            );
            return (
              <button
                key={index}
                type="button"
                className={`${index === selected ? 'active' : ''}${slotIllegal ? ' is-illegal' : ''}`}
                aria-pressed={index === selected}
                onClick={() => {
                  setSelected(index);
                  if (empty) void openSpeciesPicker(index);
                }}
              >
                <small>Slot {String(index + 1).padStart(2, '0')}{index === selected ? ' · editing' : ''}{slotIllegal ? ' · illegal' : ''}</small>
                <span className="tb-slot-ident">
                  {empty ? <PokemonIcon name="" /> : <PokemonIcon name={set.species} />}
                  <strong>{empty ? 'Choose Pokémon' : set.species}</strong>
                </span>
                <span>{empty ? 'Open Pokédex' : (set.ability || 'No ability')}{set.item && !empty ? ` · ${set.item}` : ''}</span>
                {set.teraType ? <em>Tera {set.teraType}</em> : null}
              </button>
            );
          })}
        </aside>

        <section className="tb-set">
          <header>
            <div className="tb-set-head">
              {current.species.trim() ? (
                <PokemonSprite name={current.species} dexNum={detail?.dexNum} />
              ) : (
                <span className="ps-sprite-frame empty" aria-hidden />
              )}
              <div>
                <small>{detail?.dexNum ? `Natdex #${String(detail.dexNum).padStart(4, '0')}` : 'Slot identity'}</small>
                <h2>{current.species.trim() || 'Empty slot'}</h2>
              </div>
            </div>
            <button type="button" className="pa-btn pa-btn-primary pa-btn-sm" onClick={() => void openSpeciesPicker()}>
              {current.species.trim() ? 'Change Pokémon' : 'Choose Pokémon'}
            </button>
          </header>
          <div className="tb-types">
            {(detail?.types ?? []).map(type => (
              <span key={type}><TypeMark type={type} />{type}</span>
            ))}
          </div>

          <div className="tb-set-meta">
            <div>
              <small>Held item</small>
              <button type="button" className="tb-pick" onClick={() => void openItemPicker(selected)}>
                {current.item.trim() || 'Choose item'}
              </button>
            </div>
            <label>
              Tera type
              <select value={current.teraType} onChange={event => updateSet({ teraType: event.target.value })}>
                <option value="">None</option>
                {TERA_TYPES.map(type => <option key={type}>{type}</option>)}
              </select>
            </label>
          </div>

          <div className="tb-choices">
            {(detail?.abilities ?? []).map(ability => (
              <button
                key={ability}
                type="button"
                className={ability.toLowerCase() === current.ability.trim().toLowerCase() ? 'active' : ''}
                aria-pressed={ability.toLowerCase() === current.ability.trim().toLowerCase()}
                onClick={() => updateSet({ ability })}
              >
                {ability}
              </button>
            ))}
            {!current.species.trim() ? <p className="tb-plain">Abilities appear after you pick a Pokémon.</p> : null}
          </div>

          <div className="tb-moves">
            <header>
              <strong>Attacks</strong>
              <span>{current.moves.filter(move => move.trim()).length} / 4</span>
            </header>
            {current.moves.map((move, index) => {
              const fact = moveFact(move, knownMoves, detail?.moveDetails);
              return (
                <button
                  key={index}
                  type="button"
                  className="tb-move-row"
                  onClick={() => void openMovePicker(index, selected)}
                >
                  {fact ? (
                    <>
                      <span className="tb-move-id">
                        {fact.type ? <TypeMark type={fact.type} /> : null}
                        <b>{fact.name}</b>
                      </span>
                      {fact.category ? <span className={`tb-cat is-${fact.category.toLowerCase()}`}>{fact.category}</span> : null}
                      <span className="tb-move-power">{fact.category === 'Status' ? '—' : fact.power ? fact.power : 'Var'}</span>
                    </>
                  ) : (
                    <span className="tb-move-empty">{current.species.trim() ? `Choose attack ${index + 1}` : 'Pick a Pokémon first'}</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        <div className="tb-side">
          <section className="tb-stats">
            <header>
              <strong>Stats</strong>
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

          <section className="tb-intel">
            <h3>Coverage</h3>
            {inspection?.threats.length ? (
              <ul>
                {inspection.threats.slice(0, 6).map(threat => (
                  <li key={threat.attack}>
                    <strong>{threat.attack} {formatMultiplier(threat.worst)}</strong>
                    <span>{threat.exposed.join(', ') || '—'}</span>
                  </li>
                ))}
              </ul>
            ) : <p>Coverage appears after species resolve.</p>}
            <h3>Speed</h3>
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

      {picker?.kind === 'species' ? (
        <CatalogModal
          title="Pokédex"
          hint={`${formatName} legal Pokémon`}
          query={pickerQuery}
          onQuery={setPickerQuery}
          onClose={closePicker}
          busy={catalogBusy}
          error={pickerError}
          meta={catalogBusy && !speciesCatalog ? 'Loading catalog…' : `${filteredSpecies.length} Pokémon`}
          onRetry={() => {
            if (picker?.kind === 'species') void openSpeciesPicker(picker.slot);
          }}
          filters={(
            <>
              <button type="button" className={!typeFilter ? 'active' : ''} aria-pressed={!typeFilter} onClick={() => setTypeFilter('')}>All types</button>
              {TERA_TYPES.map(type => (
                <button key={type} type="button" className={typeFilter === type ? 'active' : ''} aria-pressed={typeFilter === type} onClick={() => setTypeFilter(type)}>
                  {type}
                </button>
              ))}
            </>
          )}
        >
          {catalogBusy && !speciesCatalog ? <p className="tb-plain" role="status">Loading Pokédex…</p> : null}
          <div className="tb-dex-grid">
            {filteredSpecies.map(hit => (
              <button key={hit.name} type="button" className="tb-dex-cell" onClick={() => void adoptSpecies(hit.name, hit.types)}>
                <PokemonSprite name={hit.name} framed />
                <strong>{hit.name}</strong>
                <span className="tb-hit-meta">
                  {(hit.types ?? []).map(type => (
                    <span key={type}><TypeMark type={type} />{type}</span>
                  ))}
                </span>
              </button>
            ))}
          </div>
          {speciesCatalog && !filteredSpecies.length ? <p className="tb-plain">Nothing matches that search.</p> : null}
        </CatalogModal>
      ) : null}

      {picker?.kind === 'move' ? (
        <CatalogModal
          title="Attacks"
          className="is-attacks"
          hint={pickerSet.species.trim() ? `Legal for ${pickerSet.species}` : 'Pick a Pokémon first'}
          query={pickerQuery}
          onQuery={setPickerQuery}
          onClose={closePicker}
          busy={catalogBusy}
          error={pickerError}
          meta={catalogBusy && !learnset.length ? 'Loading learnset…' : `${filteredMoves.length} legal attacks`}
          onRetry={() => {
            if (picker?.kind === 'move') void openMovePicker(picker.moveSlot, picker.slot);
          }}
          filters={(
            <AttackFilters
              categoryFilter={categoryFilter}
              typeFilter={typeFilter}
              moveSort={moveSort}
              onCategory={setCategoryFilter}
              onType={setTypeFilter}
              onSort={setMoveSort}
            />
          )}
        >
          {catalogBusy && !learnset.length ? <p className="tb-plain" role="status">Loading learnset…</p> : null}
          <div className="tb-move-list">
            <button type="button" className="tb-clear-picker" onClick={() => { updateMoveAt(picker.slot, picker.moveSlot, ''); closePicker(); }}>
              Clear attack
            </button>
            {filteredMoves.map(hit => (
              <button
                key={hit.name}
                type="button"
                className={hit.name.toLowerCase() === pickerSet.moves[picker.moveSlot]?.trim().toLowerCase() ? 'active' : ''}
                aria-pressed={hit.name.toLowerCase() === pickerSet.moves[picker.moveSlot]?.trim().toLowerCase()}
                onClick={() => {
                  updateMoveAt(picker.slot, picker.moveSlot, hit.name);
                  rememberMoves([hit]);
                  closePicker();
                }}
              >
                <AttackCard hit={hit} showName />
              </button>
            ))}
          </div>
          {learnset.length && !filteredMoves.length ? <p className="tb-plain">Nothing matches that search.</p> : null}
        </CatalogModal>
      ) : null}

      {picker?.kind === 'item' ? (
        <CatalogModal
          title="Held item"
          hint="Legal items for this Pokémon"
          query={pickerQuery}
          onQuery={setPickerQuery}
          onClose={closePicker}
          busy={catalogBusy}
          error={pickerError}
          meta={catalogBusy && !itemCatalog ? 'Loading catalog…' : `${filteredItems.length} items`}
          onRetry={() => {
            if (picker?.kind === 'item') void openItemPicker(picker.slot);
          }}
        >
          {catalogBusy && !itemCatalog ? <p className="tb-plain" role="status">Loading items…</p> : null}
          <div className="tb-item-list">
            <button type="button" onClick={() => { updateSetAt(picker.slot, { item: '' }); closePicker(); }}>No item</button>
            {filteredItems.map(hit => (
              <button
                key={hit.name}
                type="button"
                className={hit.name.toLowerCase() === pickerSet.item.trim().toLowerCase() ? 'active' : ''}
                aria-pressed={hit.name.toLowerCase() === pickerSet.item.trim().toLowerCase()}
                onClick={() => { updateSetAt(picker.slot, { item: hit.name }); closePicker(); }}
              >
                <span className="tb-hit-name">{hit.name}</span>
                {hit.description ? <span className="tb-hit-desc">{hit.description}</span> : null}
              </button>
            ))}
          </div>
        </CatalogModal>
      ) : null}

      {picker?.kind === 'import' ? (
        <CatalogModal title="Import / export" hint="Showdown paste" query="" onQuery={() => undefined} onClose={closePicker} hideSearch>
          <textarea aria-label="Showdown paste" value={paste} onChange={event => setPaste(event.target.value)} rows={12} />
          <button type="button" className="pa-btn pa-btn-primary" onClick={() => void applyPaste()}>Apply paste</button>
        </CatalogModal>
      ) : null}
    </div>
  );
}

function AttackFilters({
  categoryFilter,
  typeFilter,
  moveSort,
  onCategory,
  onType,
  onSort,
}: {
  categoryFilter: string;
  typeFilter: string;
  moveSort: MoveSort;
  onCategory: (value: string) => void;
  onType: (value: string) => void;
  onSort: (value: MoveSort) => void;
}) {
  const [open, setOpen] = useState<null | 'kind' | 'type' | 'sort'>(null);
  const toggle = (group: 'kind' | 'type' | 'sort') => {
    setOpen(current => current === group ? null : group);
  };
  const sortLabel = MOVE_SORTS.find(option => option.id === moveSort)?.label ?? 'Name';

  return (
    <div className="tb-filter-bar">
      <div className="tb-filter-triggers" role="toolbar" aria-label="Attack filters">
        <button
          type="button"
          className={open === 'kind' || categoryFilter ? 'active' : ''}
          aria-expanded={open === 'kind'}
          onClick={() => toggle('kind')}
        >
          Kind{categoryFilter ? ` · ${categoryFilter}` : ''}
        </button>
        <button
          type="button"
          className={open === 'type' || typeFilter ? 'active' : ''}
          aria-expanded={open === 'type'}
          onClick={() => toggle('type')}
        >
          Type{typeFilter ? ` · ${typeFilter}` : ''}
        </button>
        <button
          type="button"
          className={open === 'sort' || moveSort !== 'name' ? 'active' : ''}
          aria-expanded={open === 'sort'}
          onClick={() => toggle('sort')}
        >
          Sort · {sortLabel}
        </button>
      </div>
      {open === 'kind' ? (
        <div className="tb-filter-options" role="group" aria-label="Kind">
          <button type="button" className={!categoryFilter ? 'active' : ''} aria-pressed={!categoryFilter} onClick={() => { onCategory(''); setOpen(null); }}>All</button>
          {MOVE_CATEGORIES.map(category => (
            <button
              key={category}
              type="button"
              className={categoryFilter === category ? 'active' : ''}
              aria-pressed={categoryFilter === category}
              onClick={() => { onCategory(category); setOpen(null); }}
            >
              {category}
            </button>
          ))}
        </div>
      ) : null}
      {open === 'type' ? (
        <div className="tb-filter-options" role="group" aria-label="Type">
          <button type="button" className={!typeFilter ? 'active' : ''} aria-pressed={!typeFilter} onClick={() => { onType(''); setOpen(null); }}>Any</button>
          {TERA_TYPES.map(type => (
            <button
              key={type}
              type="button"
              className={typeFilter === type ? 'active' : ''}
              aria-pressed={typeFilter === type}
              onClick={() => { onType(type); setOpen(null); }}
            >
              {type}
            </button>
          ))}
        </div>
      ) : null}
      {open === 'sort' ? (
        <div className="tb-filter-options" role="group" aria-label="Sort">
          {MOVE_SORTS.map(option => (
            <button
              key={option.id}
              type="button"
              className={moveSort === option.id ? 'active' : ''}
              aria-pressed={moveSort === option.id}
              onClick={() => { onSort(option.id); setOpen(null); }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CatalogModal({
  title,
  hint,
  query,
  onQuery,
  onClose,
  filters,
  hideSearch = false,
  busy = false,
  error,
  meta,
  onRetry,
  className,
  children,
}: {
  title: string;
  hint?: string;
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  filters?: ReactNode;
  hideSearch?: boolean;
  busy?: boolean;
  error?: string | null;
  meta?: string;
  onRetry?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    if (!card) return undefined;

    const focusable = () => Array.from(card.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const first = focusable()[0];
    first?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) {
        event.preventDefault();
        return;
      }
      const firstElement = elements[0]!;
      const lastElement = elements[elements.length - 1]!;
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  const titleId = 'team-builder-modal-title';
  const hintId = 'team-builder-modal-hint';
  return (
    <div className="tb-modal" onClick={onClose}>
      <div
        ref={cardRef}
        className={`tb-modal-card${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hint ? hintId : undefined}
        aria-busy={busy}
        onClick={event => event.stopPropagation()}
      >
        <header>
          <div>
            {hint ? <small id={hintId}>{hint}</small> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="pa-btn pa-btn-surface pa-btn-sm" onClick={onClose} aria-label={`Close ${title}`}>Close</button>
        </header>
        {hideSearch ? null : (
          <input
            aria-label={`Search ${title.toLowerCase()}`}
            value={query}
            placeholder="Search by name"
            onChange={event => onQuery(event.target.value)}
          />
        )}
        {filters ? <div className="tb-modal-filters">{filters}</div> : null}
        {meta ? <p className="tb-modal-meta" aria-live="polite">{meta}</p> : null}
        {error ? (
          <div className="tb-picker-error" role="alert">
            <p>{error}</p>
            {onRetry ? <button type="button" onClick={onRetry}>Retry</button> : null}
          </div>
        ) : null}
        <div className="tb-modal-body">{children}</div>
      </div>
    </div>
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
