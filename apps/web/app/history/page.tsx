'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { TrainerName } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { formatPoke, formatSolLamports } from '@/lib/api-client';
import type { FightHistoryCursor, FightHistoryEntry } from '@/lib/protocol';

const PAGE_SIZE = 20;

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

export default function HistoryPage() {
  const { client, playerId, connectionState } = useArena();
  const [entries, setEntries] = useState<FightHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<FightHistoryCursor | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before?: FightHistoryCursor) => {
    if (!playerId) return;
    const response = await client.request({
      type: 'history.list',
      limit: PAGE_SIZE,
      ...(before
        ? { beforeCompletedAt: before.completedAt, beforeId: before.id }
        : {}),
    });
    if (response.type !== 'history.list') {
      throw new Error('Fight history did not load.');
    }
    setEntries(current => before ? [...current, ...response.entries] : response.entries);
    setCursor(response.nextCursor);
  }, [client, playerId]);

  useEffect(() => {
    if (!playerId) {
      setLoading(false);
      setError(null);
      return;
    }
    if (connectionState !== 'open') {
      setLoading(connectionState !== 'closed');
      if (connectionState === 'closed') setError('Reconnect to see your fight history.');
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
    <div className="pa-page">
      <header className="pa-page-head">
        <h1>History</h1>
        <p className="pa-lead">Completed fights and the balance change recorded for each one.</p>
      </header>

      {!playerId ? (
        <p className="pa-lead">Connect a wallet to see your fight history.</p>
      ) : null}
      {playerId && loading ? <p className="pa-lead pa-async">Loading your fights…</p> : null}
      {playerId && !loading && error ? (
        <p className="pa-lead" role="alert">{error}</p>
      ) : null}
      {playerId && !loading && !error && entries.length === 0 ? (
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
        <button type="button" className="pa-btn" disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? 'Loading…' : 'Older fights'}
        </button>
      ) : null}
    </div>
  );
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

function formatNet(entry: FightHistoryEntry): string {
  if (!entry.paid) return 'Unsettled';
  const amount = formatAmount(Math.abs(entry.net), entry.symbol);
  if (entry.net > 0) return `+${amount}`;
  if (entry.net < 0) return `-${amount}`;
  return `+${amount}`;
}

function netTone(entry: FightHistoryEntry): string {
  if (!entry.paid || entry.net === 0) return 'flat';
  return entry.net > 0 ? 'up' : 'down';
}
