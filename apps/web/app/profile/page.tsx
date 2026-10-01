'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { TrainerName } from '@/components/profile-trainer';
import { TeamStrip } from '@/components/showdown-visuals';
import { TrainerSetup } from '@/components/trainer-profile';
import { useArena } from '@/lib/arena-context';
import { formatPoke, formatSolLamports } from '@/lib/api-client';
import type { FightHistoryCursor, FightHistoryEntry } from '@/lib/protocol';
import { readAllFormatTeams, readSavedTeam, type SavedTeam } from '@/lib/team';
import { shortenAddress, trainerSpriteSrc } from '@/lib/trainer-profile';

const PAGE_SIZE = 25;
const PAGE_CAP = 12;

const RESULT_LABEL: Record<FightHistoryEntry['result'], string> = {
  win: 'Win',
  loss: 'Loss',
  tie: 'Tie',
  forfeit: 'Forfeit',
};

const MODE_LABEL: Record<FightHistoryEntry['mode'], string> = {
  casual: 'Casual',
  competitive: 'Competitive',
  tournament: 'Tournament',
};

export default function ProfilePage() {
  const router = useRouter();
  const {
    client,
    playerId,
    playerLabel,
    connectionState,
    snapshot,
    trainerSpriteId,
    trainerUsername,
    previewSession,
    walletAddress,
    authBusy,
    saveTrainerProfile,
    disconnectInjectedWallet,
  } = useArena();
  const [entries, setEntries] = useState<FightHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<FightHistoryCursor | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [team, setTeam] = useState<SavedTeam | null>(null);

  const load = useCallback(async (before?: FightHistoryCursor) => {
    if (!playerId) return;
    const collected: FightHistoryEntry[] = [];
    let pageCursor = before;
    let next: FightHistoryCursor | undefined;
    for (let page = 0; page < (before ? 1 : PAGE_CAP); page += 1) {
      const response = await client.request({
        type: 'history.list',
        limit: PAGE_SIZE,
        ...(pageCursor
          ? { beforeCompletedAt: pageCursor.completedAt, beforeId: pageCursor.id }
          : {}),
      });
      if (response.type !== 'history.list') {
        throw new Error('Fight history did not load.');
      }
      collected.push(...response.entries);
      next = response.nextCursor;
      if (!next || before) break;
      pageCursor = next;
    }
    setEntries(current => before ? [...current, ...collected] : collected);
    setCursor(next);
  }, [client, playerId]);

  useEffect(() => {
    setTeam(playerId ? lockedTeam(playerId) : null);
  }, [playerId]);

  useEffect(() => {
    if (!playerId) {
      setLoading(false);
      setError(null);
      return;
    }
    if (connectionState !== 'open') {
      setLoading(connectionState !== 'closed');
      if (connectionState === 'closed') setError('Reconnect to see your profile.');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void load()
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Fight history did not load.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionState, load, playerId]);

  const stats = useMemo(() => summarize(entries), [entries]);
  const balance = snapshot?.chainEconomyEnabled && snapshot.solBalances
    ? formatSolLamports(Number(snapshot.solBalances.freeLamports))
    : snapshot
      ? formatPoke(snapshot.wallet.balance)
      : '—';

  const loadMore = () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    void load(cursor)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Fight history did not load.');
      })
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="pa-page pa-page-profile">
      <header className="pa-page-head">
        <h1>Profile</h1>
        <p className="pa-lead">Your trainer, record, and the fights behind it.</p>
      </header>

      {!playerId ? (
        <p className="pa-lead">Connect a wallet to open your profile.</p>
      ) : (
        <>
          <section className="pa-profile">
            <aside className="pa-vault pa-profile-identity">
              <img src={trainerSpriteSrc(trainerSpriteId)} alt="" width={128} height={128} />
              <div className="pa-profile-foot">
                <div>
                  <small>{previewSession ? 'Browser preview' : 'Trainer'}</small>
                  <strong>{trainerUsername ?? playerLabel}</strong>
                  <em>
                    {previewSession
                      ? 'No extension on this browser'
                      : walletAddress
                        ? shortenAddress(walletAddress, 6)
                        : playerLabel}
                  </em>
                </div>
                <div className="pa-profile-actions">
                <button type="button" className="pa-btn pa-btn-primary" onClick={() => setEditing(true)}>
                  Edit profile
                </button>
                <button
                  type="button"
                  className="pa-btn pa-btn-surface"
                  disabled={authBusy}
                  onClick={() => {
                    void disconnectInjectedWallet().then(() => router.push('/'));
                  }}
                >
                  Disconnect
                </button>
                </div>
              </div>
            </aside>

            <div className="pa-profile-main">
              <div className="pa-profile-stats">
                <article className="pa-profile-stat">
                  <small>PnL</small>
                  <strong className={stats.pnlTone}>{stats.pnl}</strong>
                </article>
                <article className="pa-profile-stat">
                  <small>Record</small>
                  <strong>{stats.record}</strong>
                  <em>Wins · losses · ties</em>
                </article>
                <article className="pa-profile-stat">
                  <small>Win rate</small>
                  <strong>{stats.winRate}</strong>
                </article>
                <article className="pa-profile-stat">
                  <small>Streak</small>
                  <strong>{stats.streak}</strong>
                </article>
              </div>

              <div className="pa-split">
                <article className="pa-vault">
                  <header>
                    <h2>Most used team</h2>
                    <span className="ok">{team?.validated ? 'Locked' : 'Not locked'}</span>
                  </header>
                  {team ? (
                    <div className="pa-profile-team">
                      <strong>{team.name || 'Untitled team'}</strong>
                      <span>{formatRuleset(team.rulesetId)}</span>
                      <TeamStrip species={team.species} slots={6} />
                      <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/teams">Open My Teams</Link>
                    </div>
                  ) : (
                    <div className="pa-profile-team">
                      <p>No team saved on this trainer yet.</p>
                      <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/teams/builder">Build a team</Link>
                    </div>
                  )}
                </article>
                <article className="pa-vault">
                  <header>
                    <h2>Record book</h2>
                    <span className="ok">{stats.fights} fights</span>
                  </header>
                  <div className="pa-econ-rows">
                    <div><span>Balance</span><strong>{balance}</strong></div>
                    <div><span>Last fight</span><strong>{stats.last}</strong></div>
                    <div><span>Casual</span><strong>{stats.modes.casual}</strong></div>
                    <div><span>Competitive</span><strong>{stats.modes.competitive}</strong></div>
                    <div><span>Tournaments</span><strong>{stats.modes.tournament}</strong></div>
                    <div><span>Forfeits</span><strong>{stats.forfeits}</strong></div>
                  </div>
                </article>
              </div>
            </div>
          </section>

          <section className="pa-profile-history">
            <header>
              <h2>Fight history</h2>
              <p>Completed fights and the balance change recorded for each one.</p>
            </header>
            {loading ? <p className="pa-lead pa-async">Loading your fights…</p> : null}
            {!loading && error ? <p className="pa-lead" role="alert">{error}</p> : null}
            {!loading && !error && entries.length === 0 ? (
              <p className="pa-lead">No completed fights yet. A fight shows up here after it settles.</p>
            ) : null}
            <div className="pa-history">
              {entries.map(entry => (
                <Link
                  key={entry.id}
                  href={entry.detailPath}
                  className={`pa-history-row outcome-${entry.result}`}
                >
                  <time dateTime={new Date(entry.completedAt).toISOString()}>{formatWhen(entry.completedAt)}</time>
                  <span className="pa-history-result">
                    {RESULT_LABEL[entry.result]}
                    <small>{MODE_LABEL[entry.mode]}</small>
                  </span>
                  <span className="pa-history-vs">
                    <small>vs</small>
                    <strong><TrainerName playerId={entry.opponentId} fallback="Opponent" /></strong>
                  </span>
                  <span className={`pa-history-net ${netTone(entry)}`}>{formatNet(entry)}</span>
                </Link>
              ))}
            </div>
            {cursor ? (
              <button type="button" className="pa-btn pa-btn-surface" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? 'Loading…' : 'Older fights'}
              </button>
            ) : null}
          </section>
        </>
      )}

      {editing && playerId ? (
        <TrainerSetup
          required={false}
          initialUsername={trainerUsername ?? ''}
          initialSpriteId={trainerSpriteId}
          busy={authBusy}
          onSave={(username, spriteId) => {
            saveTrainerProfile(username, spriteId);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          onDisconnect={() => {
            void disconnectInjectedWallet().then(() => router.push('/'));
          }}
        />
      ) : null}
    </div>
  );
}

function lockedTeam(playerId: string): SavedTeam | null {
  const current = readSavedTeam(playerId);
  if (current && (current.species.length > 0 || current.paste.trim())) return current;
  const saved = readAllFormatTeams(playerId);
  return saved.find(team => team.validated) ?? saved[0] ?? null;
}

function summarize(entries: readonly FightHistoryEntry[]) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let forfeits = 0;
  const modes = { casual: 0, competitive: 0, tournament: 0 };
  const nets = new Map<FightHistoryEntry['symbol'], number>();
  for (const entry of entries) {
    modes[entry.mode] += 1;
    if (entry.result === 'win') wins += 1;
    else if (entry.result === 'tie') ties += 1;
    else if (entry.result === 'forfeit') forfeits += 1;
    else losses += 1;
    if (entry.paid) nets.set(entry.symbol, (nets.get(entry.symbol) ?? 0) + entry.net);
  }
  const decisive = wins + losses + forfeits;
  const poke = nets.get('POKE');
  const sol = nets.get('SOL');
  const primary = poke ?? sol;
  const symbol: FightHistoryEntry['symbol'] | null = poke != null ? 'POKE' : sol != null ? 'SOL' : null;
  return {
    fights: entries.length,
    forfeits,
    modes,
    record: entries.length ? `${wins}W–${losses + forfeits}L–${ties}T` : '—',
    winRate: decisive ? `${Math.round((wins / decisive) * 100)}%` : '—',
    streak: streakLabel(entries),
    last: entries[0] ? formatWhen(entries[0].completedAt) : '—',
    pnl: primary == null || !symbol ? '—' : signedAmount(primary, symbol),
    pnlTone: primary == null || primary === 0 ? 'flat' : primary > 0 ? 'up' : 'down',
  };
}

function streakLabel(entries: readonly FightHistoryEntry[]): string {
  let index = 0;
  while (index < entries.length && entries[index].result === 'tie') index += 1;
  const first = entries[index];
  if (!first) return '—';
  const winning = first.result === 'win';
  let count = 0;
  for (let cursor = index; cursor < entries.length; cursor += 1) {
    const entry = entries[cursor];
    if (entry.result === 'tie') break;
    if ((entry.result === 'win') !== winning) break;
    count += 1;
  }
  return `${count}${winning ? 'W' : 'L'}`;
}

function formatRuleset(rulesetId?: string): string {
  if (!rulesetId || rulesetId === 'gen9ou') return 'Gen 9 OU';
  const cup = /^gen(\d+)cup$/.exec(rulesetId);
  if (cup) return `Gen ${cup[1]} Cup`;
  return rulesetId;
}

function formatWhen(completedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(completedAt);
}

function formatAmount(amount: number, symbol: FightHistoryEntry['symbol']): string {
  return symbol === 'SOL' ? formatSolLamports(amount) : formatPoke(amount);
}

function signedAmount(amount: number, symbol: FightHistoryEntry['symbol']): string {
  const shown = formatAmount(Math.abs(amount), symbol);
  if (amount > 0) return `+${shown}`;
  if (amount < 0) return `-${shown}`;
  return shown;
}

function formatNet(entry: FightHistoryEntry): string {
  if (!entry.paid) return 'Unsettled';
  return signedAmount(entry.net, entry.symbol);
}

function netTone(entry: FightHistoryEntry): string {
  if (!entry.paid || entry.net === 0) return 'flat';
  return entry.net > 0 ? 'up' : 'down';
}
