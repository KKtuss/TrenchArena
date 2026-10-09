'use client';

import { useCallback, useEffect, useState } from 'react';

import Link from 'next/link';

import { ProfileTrainerSprite } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { formatSolLamports } from '@/lib/api-client';
import type { LeaderboardRow } from '@/lib/protocol';
import { shortenAddress } from '@/lib/trainer-profile';

export default function LeaderboardPage() {
  const { client, playerId, connectionState } = useArena();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      await client.ensureOpen();
      const response = await client.request({ type: 'leaderboard.list' });
      if (response.type !== 'leaderboard.list') {
        throw new Error('Leaderboard did not load.');
      }
      setRows(response.rows);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Leaderboard did not load.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [connectionState, load]);

  return (
    <div className="pa-page cup-page">
      <header className="cup-head">
        <div className="cup-head-copy">
          <h1 className="cup-title">Leaderboard</h1>
          <p className="cup-lead">
            Registered trainers ranked by SOL profit, then win rate, then fights played.
          </p>
        </div>
        <div className="cup-actions">
          <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
        </div>
      </header>

      <article className="cup-panel pa-board-panel">
        <header className="cup-panel-head">
          <h2>Standings</h2>
          <span>{rows.length ? `${rows.length} trainers` : 'Open board'}</span>
        </header>
        {loading ? <p className="cup-lead pa-async">Loading standings…</p> : null}
        {!loading && error ? <p className="cup-lead" role="alert">{error}</p> : null}
        {!loading && !error && rows.length === 0 ? (
          <p className="cup-lead">No trainers have published a profile yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <div className="pa-board-list" role="table" aria-label="Trainer standings">
            <div className="pa-board-row pa-board-cols" role="row">
              <span role="columnheader">Rank</span>
              <span role="columnheader">Trainer</span>
              <span role="columnheader">Fights</span>
              <span role="columnheader">W/R</span>
              <span role="columnheader">SOL PnL</span>
            </div>
            {rows.map(row => (
              <div
                key={row.playerId}
                className={`pa-board-row${row.playerId === playerId ? ' is-you' : ''}`}
                role="row"
              >
                <span className="pa-board-rank" role="cell">{formatRank(row.rank)}</span>
                <span className="pa-board-trainer" role="cell">
                  <ProfileTrainerSprite label={row.username} spriteId={row.spriteId} />
                  <span className="pa-board-trainer-copy">
                    <strong>
                      {row.username}
                      {row.playerId === playerId ? <small>You</small> : null}
                    </strong>
                    <code className="pa-board-wallet" title={row.playerId}>{shortenAddress(row.playerId, 6)}</code>
                  </span>
                </span>
                <span className="pa-board-stat pa-board-fights" role="cell">
                  <small>Fights</small>
                  <b>{row.fights}</b>
                </span>
                <span className="pa-board-stat pa-board-wr" role="cell">
                  <small>W/R</small>
                  <b>{formatWinRate(row.winRateBps)}</b>
                </span>
                <span className={`pa-board-pnl ${pnlTone(row.solPnlLamports)}`} role="cell">
                  <small>SOL PnL</small>
                  <b>{formatSolPnl(row.solPnlLamports)}</b>
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </article>
    </div>
  );
}

function formatRank(rank: number): string {
  return String(rank).padStart(2, '0');
}

function formatWinRate(winRateBps: number | null): string {
  if (winRateBps == null) return '—';
  return `${Math.round(winRateBps / 100)}%`;
}

function formatSolPnl(lamports: number): string {
  const formatted = formatSolLamports(Math.abs(lamports));
  if (lamports > 0) return `+${formatted}`;
  if (lamports < 0) return `−${formatted}`;
  return formatted;
}

function pnlTone(lamports: number): string {
  if (lamports > 0) return 'is-up';
  if (lamports < 0) return 'is-down';
  return 'is-flat';
}
