'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { ErrorToast } from '@/components/error-toast';
import { FormatStage, Gen1CupArt } from '@/components/gen1-cup-art';
import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import { isLocalTestMode } from '@/lib/local-test-mode';
import {
  TOURNAMENT_ENTRY_POKE,
  TOURNAMENT_FIELD_SIZE,
  buildTournamentSchedule,
  formatCountdown,
  previewTreasuryPrize,
  scheduleCtaLabel,
  scheduleStatusLabel,
  type ScheduleSlot,
} from '@/lib/tournament-schedule';
import { readSavedTeam } from '@/lib/team';

export default function TournamentsPage() {
  const { client, snapshot, refreshSnapshot, connected, walletConnected, connectInjectedWallet, connectingWallet, playerId } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null until mount so SSR and hydration share the same countdown placeholder
  const [now, setNow] = useState<number | null>(null);
  const localTestMode = isLocalTestMode();

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
    () => buildTournamentSchedule(snapshot?.tournaments ?? [], now ?? Date.now(), {
      allAvailable: localTestMode,
    }),
    [localTestMode, snapshot?.tournaments, now],
  );

  const ensureTournament = async (slot: ScheduleSlot): Promise<string | null> => {
    if (slot.tournament) return slot.tournament.id;
    if (!walletConnected) {
      setError('Connect a wallet before joining a tournament.');
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await client.request({
        type: 'tournament.create',
        title: slot.title,
        maxPlayers: TOURNAMENT_FIELD_SIZE,
        entryFee: TOURNAMENT_ENTRY_POKE,
        ruleset: slot.rulesetId,
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
          <h1>Tournament schedule</h1>
          <p className="pa-lead">
            Preset Gen X, then that generation&apos;s custom cup, then Gen 9 OU. A new tournament every 30 minutes.
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
        <span className="pa-live-pill"><i /> 30-minute cadence</span>
        <span className="pa-strip-end">No withdrawal tax</span>
      </div>

      <section className="pa-schedule">
        <div className="pa-schedule-list">
          {schedule.map(slot => (
            <ScheduleCard
              key={slot.key}
              slot={slot}
              now={now}
              busy={busy}
              teamReady={slot.format.teamMode === 'custom'
                ? Boolean(playerId && readSavedTeam(playerId, slot.rulesetId)?.validated
                  && readSavedTeam(playerId, slot.rulesetId)?.paste.trim())
                : null}
              onJoin={async () => {
                if (slot.when !== 'CURRENT') return;
                if (slot.format.teamMode === 'custom') {
                  const saved = playerId ? readSavedTeam(playerId, slot.rulesetId) : null;
                  if (!saved?.validated || !saved.paste.trim()) {
                    window.location.href = `/teams/builder?ruleset=${slot.rulesetId}`;
                    return;
                  }
                  const id = slot.tournament?.id ?? await ensureTournament(slot);
                  if (!id) return;
                  try {
                    await client.request({
                      type: 'tournament.join',
                      tournamentId: id,
                      team: saved.paste,
                    });
                  } catch (err) {
                    const text = err instanceof Error ? err.message : String(err);
                    if (!/already registered/i.test(text)) {
                      setError(text);
                      return;
                    }
                  }
                  window.location.href = `/tournament/${id}`;
                  return;
                }
                if (slot.tournament) {
                  window.location.href = `/tournament/${slot.tournament.id}`;
                  return;
                }
                const id = await ensureTournament(slot);
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
          <p>
            About $5 of POKE is burned at bracket lock. The prize is SOL from the Tournament Treasury,
            not player collateral.
            {snapshot?.chainEconomyEnabled ? '' : ` (Legacy mock entry ${formatPoke(TOURNAMENT_ENTRY_POKE)}.)`}
          </p>
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
  teamReady,
  onJoin,
}: {
  slot: ScheduleSlot;
  now: number | null;
  busy: boolean;
  teamReady: boolean | null;
  onJoin: () => void;
}) {
  const joinable = slot.when === 'CURRENT';
  const prizeKnown = joinable;
  const economics = slot.tournament?.economics
    ?? previewTreasuryPrize(TOURNAMENT_ENTRY_POKE, TOURNAMENT_FIELD_SIZE);
  const players = slot.tournament?.playerCount ?? 0;
  const maxPlayers = slot.tournament?.maxPlayers ?? TOURNAMENT_FIELD_SIZE;
  const status = scheduleStatusLabel(slot);
  const cta = joinable ? scheduleCtaLabel(slot) : 'UPCOMING';
  const finalizesAt = slot.tournament?.finalizesAt;
  const locking = finalizesAt != null && now != null && now < finalizesAt;
  const countdownTarget = locking
    ? finalizesAt
    : now != null && now >= slot.startsAt ? slot.endsAt : slot.startsAt;
  const countdown = now == null ? '--:--:--' : formatCountdown(countdownTarget, now);
  const countdownLabel = locking ? 'Locks in' : now != null && now >= slot.startsAt ? 'Window' : 'Starts in';
  const href = joinable && slot.tournament ? `/tournament/${slot.tournament.id}` : undefined;
  const isGen1Cup = slot.format.id === 'gen1cup';
  const prize = prizeKnown ? economics.prizePool.toLocaleString('en-US') : 'TBD';

  return (
    <article className={`pa-schedule-card ${slot.kind} is-format is-${slot.format.accent}${isGen1Cup ? ' is-gen1' : ''}${joinable ? '' : ' is-upcoming'}`}>
      <div className="pa-schedule-card-mark">
        <span>{slot.when}</span>
        <strong>{slot.title}</strong>
        <small>{slot.themeLabel}</small>
        <small>{slot.format.teamModeLabel} · {maxPlayers} PLAYERS</small>
      </div>

      {isGen1Cup ? (
        <Gen1CupArt compact />
      ) : (
        <FormatStage compact trainer={slot.format.trainer} pokemon={slot.format.pokemon} />
      )}

      {!joinable ? (
        <div className="pa-schedule-countdown-overlay" aria-label={`${countdownLabel} ${countdown}`}>
          <small>{countdownLabel}</small>
          <strong>{countdown}</strong>
        </div>
      ) : null}

      <div className="pa-schedule-card-close">
        <div className="pa-schedule-prize">
          <small>Treasury prize</small>
          <strong>
            <em>{prize}</em>
            {prizeKnown ? <span>POKE</span> : null}
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
            <dd>{`${players} / ${maxPlayers}`}</dd>
          </div>
          {joinable ? (
            <div>
              <dt>{countdownLabel}</dt>
              <dd>{countdown}</dd>
            </div>
          ) : null}
        </dl>
        {!joinable ? (
          <button type="button" className="pa-btn pa-btn-surface" disabled>
            Upcoming
          </button>
        ) : teamReady === false ? (
          <Link className="pa-btn pa-btn-gold" href={`/teams/builder?ruleset=${slot.rulesetId}`}>
            No available team
          </Link>
        ) : href ? (
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
        )}
      </div>
    </article>
  );
}
