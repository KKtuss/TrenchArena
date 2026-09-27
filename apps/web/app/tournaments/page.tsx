'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { ErrorToast } from '@/components/error-toast';
import { Gen1CupArt } from '@/components/gen1-cup-art';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import {
  GEN1_CUP_TITLE,
  TOURNAMENT_ENTRY_POKE,
  TOURNAMENT_FIELD_SIZE,
  buildTournamentSchedule,
  formatCountdown,
  previewTreasuryPrize,
  scheduleCtaLabel,
  scheduleStatusLabel,
  type ScheduleSlot,
} from '@/lib/tournament-schedule';

export default function TournamentsPage() {
  const { client, snapshot, refreshSnapshot, connected, walletConnected, connectInjectedWallet, connectingWallet } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null until mount so SSR and hydration share the same countdown placeholder
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!connected) return;
    void client.request({ type: 'tournament.list' }).then(() => refreshSnapshot()).catch(() => undefined);
  }, [client, connected, refreshSnapshot]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const schedule = useMemo(
    () => buildTournamentSchedule(snapshot?.tournaments ?? [], now ?? Date.now()),
    [snapshot?.tournaments, now],
  );

  const ensureGen1Cup = async (): Promise<string | null> => {
    const existing = schedule[0]?.tournament;
    if (existing) return existing.id;
    if (!walletConnected) {
      setError('Connect a wallet before joining the Gen 1 Cup.');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await client.request({
        type: 'tournament.create',
        title: GEN1_CUP_TITLE,
        maxPlayers: TOURNAMENT_FIELD_SIZE,
        entryFee: TOURNAMENT_ENTRY_POKE,
      });
      await refreshSnapshot();
      if (response.type === 'tournament.created') {
        return (response.tournament as { id?: string })?.id ?? null;
      }
      return null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <p className="pa-kicker"><i /> — Championship circuit · hourly cups —</p>
          <h1>Tournament schedule</h1>
          <p className="pa-lead">
            One cup at a time. Low entry. Treasury-funded prizes. Future themes stay UNKNOWN until announced.
          </p>
        </div>
        <div className="pa-page-actions">
          {!walletConnected ? (
            <button
              type="button"
              className="pa-btn pa-btn-primary"
              disabled={connectingWallet}
              onClick={() => void connectInjectedWallet()}
            >
              {connectingWallet ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : null}
          <Link className="pa-btn pa-btn-surface" href="/treasury">Treasury map</Link>
        </div>
      </header>

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      <div className="pa-live-strip">
        <span className="pa-live-pill"><i /> Hourly cadence</span>
        <strong>1 live cup</strong>
        <span>Next cups every 60 minutes</span>
        <span style={{ marginLeft: 'auto', color: '#8ea0c0' }}>No withdrawal tax</span>
      </div>

      <section className="pa-schedule">
        <div className="pa-schedule-list">
          {schedule.map(slot => (
            <ScheduleCard
              key={slot.key}
              slot={slot}
              now={now}
              busy={busy}
              onJoin={async () => {
                if (slot.theme === 'unknown') return;
                if (slot.tournament) {
                  window.location.href = `/tournament/${slot.tournament.id}`;
                  return;
                }
                const id = await ensureGen1Cup();
                if (id) window.location.href = `/tournament/${id}`;
              }}
            />
          ))}
        </div>
      </section>

      <section className="pa-mode-pair">
        <article className="pa-mode-panel casual">
          <header>
            <div>
              <small>Casual</small>
              <h3>Player-funded</h3>
            </div>
            <span>Collateral</span>
          </header>
          <p>Each side posts collateral. Large stakes possible. One 2% fee from the gross pool at match start.</p>
          <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/arena">Open arena</Link>
        </article>
        <article className="pa-mode-panel cup">
          <header>
            <div>
              <small>Tournament</small>
              <h3>Treasury-funded</h3>
            </div>
            <span>Low entry</span>
          </header>
          <p>Small {formatPoke(TOURNAMENT_ENTRY_POKE)} entry. The major prize comes from the Tournament Treasury, not player collateral.</p>
          <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/treasury">See funding</Link>
        </article>
      </section>

      <div className="pa-soon">
        <span>Register</span>
        <span aria-hidden>→</span>
        <span>Round of 32</span>
        <span aria-hidden>→</span>
        <span>Final</span>
        <span aria-hidden>→</span>
        <span>Champion</span>
      </div>
    </div>
  );
}

function ScheduleCard({
  slot,
  now,
  busy,
  onJoin,
}: {
  slot: ScheduleSlot;
  now: number | null;
  busy: boolean;
  onJoin: () => void;
}) {
  const economics = slot.tournament?.economics
    ?? previewTreasuryPrize(TOURNAMENT_ENTRY_POKE, TOURNAMENT_FIELD_SIZE);
  const players = slot.tournament?.playerCount ?? 0;
  const maxPlayers = slot.tournament?.maxPlayers ?? TOURNAMENT_FIELD_SIZE;
  const status = scheduleStatusLabel(slot);
  const cta = scheduleCtaLabel(slot);
  const locked = slot.theme === 'unknown';
  const countdown = now == null ? '--:--:--' : formatCountdown(slot.startsAt, now);
  const href = slot.tournament ? `/tournament/${slot.tournament.id}` : undefined;
  const isGen1 = slot.theme === 'gen1';
  const prize = economics.prizePool.toLocaleString('en-US');

  return (
    <article className={`pa-schedule-card ${slot.kind}${locked ? ' is-locked' : ''}${isGen1 ? ' is-gen1' : ''}`}>
      <div className="pa-schedule-card-mark">
        <span>{slot.kind === 'now' ? 'NOW' : 'NEXT'}</span>
        <strong>{slot.title}</strong>
        <small>{isGen1 ? `KANTO · ${maxPlayers} PLAYERS` : slot.themeLabel}</small>
      </div>

      {isGen1 ? (
        <Gen1CupArt compact />
      ) : (
        <div className="pa-schedule-card-when">
          <small>Starts in</small>
          <strong>{countdown}</strong>
        </div>
      )}

      <div className="pa-schedule-card-close">
        <div className="pa-schedule-prize">
          <small>Treasury prize</small>
          <strong>
            <em>{prize}</em>
            <span>POKE</span>
          </strong>
        </div>
        <dl className="pa-schedule-facts">
          <div>
            <dt>Entry</dt>
            <dd>{formatPoke(TOURNAMENT_ENTRY_POKE)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className={`pa-schedule-status status-${status.toLowerCase()}`}>{status}</dd>
          </div>
          <div>
            <dt>Field</dt>
            <dd>{locked ? `— / ${maxPlayers}` : `${players} / ${maxPlayers}`}</dd>
          </div>
        </dl>
        {isGen1 ? (
          href ? (
            <Link className="pa-btn pa-btn-gold" href={href}>{cta}</Link>
          ) : (
            <button
              type="button"
              className="pa-btn pa-btn-gold"
              disabled={busy}
              onClick={onJoin}
            >
              {busy ? 'Opening…' : cta}
            </button>
          )
        ) : (
          <button type="button" className="pa-btn pa-btn-surface" disabled>
            {cta}
          </button>
        )}
      </div>
    </article>
  );
}
