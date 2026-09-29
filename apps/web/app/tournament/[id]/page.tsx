'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ErrorToast } from '@/components/error-toast';
import { Gen1CupArt } from '@/components/gen1-cup-art';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { BracketView, TournamentEconomicsBlock } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import { isDemoAuthEnabled } from '@/lib/demo-auth';
import { formatPoke } from '@/lib/api-client';
import { battlePaste, readSavedTeam, type SavedTeam } from '@/lib/team';
import {
  TOURNAMENT_ENTRY_POKE,
  TOURNAMENT_FIELD_SIZE,
  previewTreasuryPrize,
} from '@/lib/tournament-schedule';

type BracketMatch = {
  id: string;
  round: number;
  bracketPosition: number;
  player1?: string;
  player2?: string;
  status: string;
  winner?: string;
};

type TournamentPlayer = {
  id: string;
  status: string;
  displayName?: string;
};

type TournamentDetail = {
  id: string;
  title: string;
  format: string;
  status: string;
  maxPlayers: number;
  players?: TournamentPlayer[];
  bracket?: BracketMatch[];
  entryFee?: number;
  hostId?: string;
  economics?: {
    prizePool: number;
    entryFee: number;
    playerCount: number;
    treasuryShare: number;
  };
  winner?: string;
};

export default function TournamentDetailPage() {
  const params = useParams<{ id: string }>();
  const tournamentId = params.id;
  const { client, playerId, walletConnected, connectInjectedWallet, connectingWallet } = useArena();
  const [tournament, setTournament] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedTeam | null>(null);

  useEffect(() => {
    setSaved(playerId ? readSavedTeam(playerId) : null);
  }, [playerId]);

  useEffect(() => {
    if (!walletConnected) return;
    const unsubscribe = client.onMessage(message => {
      if (
        (message.type === 'tournament.state' || message.type === 'tournament.created' || message.type === 'tournament.result')
        && message.tournament?.id === tournamentId
      ) {
        setTournament(message.tournament as TournamentDetail);
      }
    });
    void client.request({ type: 'tournament.subscribe', tournamentId }).then(response => {
      if (response.type === 'tournament.state') setTournament(response.tournament as TournamentDetail);
    }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    return unsubscribe;
  }, [client, walletConnected, tournamentId]);

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const registeredPlayers = useMemo(
    () => (tournament?.players ?? []).filter(player => player.status === 'registered'),
    [tournament?.players],
  );
  const registered = registeredPlayers.some(player => player.id === playerId);
  const maxPlayers = tournament?.maxPlayers ?? TOURNAMENT_FIELD_SIZE;
  const entryFee = tournament?.entryFee ?? TOURNAMENT_ENTRY_POKE;
  const liveMatch = tournament?.bracket?.find(match => (
    match.status === 'active' || match.status === 'battle-created'
  ));
  const myMatch = tournament?.bracket?.find(match => (
    (match.player1 === playerId || match.player2 === playerId)
    && ['ready', 'active', 'battle-created', 'completed'].includes(match.status)
  ));
  const bracketLive = tournament?.status === 'in-progress' || tournament?.status === 'active';
  const canRegister = tournament?.status === 'registration' || tournament?.status === 'draft';

  const prizePool = tournament?.economics?.prizePool
    ?? previewTreasuryPrize(entryFee, maxPlayers).prizePool;
  const statusLabel = (tournament?.status ?? 'registration').toUpperCase();

  return (
    <div className="pa-page">
      <section className="pa-gen1-hero-band">
        <div className="pa-gen1-hero-copy">
          <p className="pa-kicker"><i /> — Kanto · {maxPlayers}-player single elimination —</p>
          <h1>{tournament?.title ?? 'GEN 1 CUP'}</h1>
          <p className="pa-lead">
            Low {formatPoke(entryFee)} entry. Prize pool funded by the PokeArena Tournament Treasury.
          </p>
          <div className="pa-schedule-prize">
            <small>Projected treasury prize</small>
            <strong>{formatPoke(prizePool)}</strong>
          </div>
          <p className="pa-gen1-facts is-start">
            <span>{formatPoke(entryFee)} entry</span>
            <i aria-hidden />
            <span className="pa-schedule-status status-registering">{statusLabel}</span>
            <i aria-hidden />
            <span>{registeredPlayers.length} / {maxPlayers}</span>
          </p>
          <div className="pa-gen1-hero-actions">
            {!walletConnected ? (
              <button
                type="button"
                className="pa-btn pa-btn-primary"
                disabled={connectingWallet}
                onClick={() => void connectInjectedWallet()}
              >
                {connectingWallet ? 'Connecting…' : 'Connect wallet'}
              </button>
            ) : !registered && canRegister ? (
              <button
                type="button"
                className="pa-btn pa-btn-primary"
                disabled={busy}
                onClick={() => void act(async () => {
                  if (!playerId) throw new Error('Connect a wallet before joining.');
                  const paste = battlePaste(playerId);
                  const response = await client.request({
                    type: 'tournament.join',
                    tournamentId,
                    ...(paste ? { team: paste } : {}),
                  });
                  if (response.type === 'tournament.state') {
                    setTournament(response.tournament as TournamentDetail);
                  }
                })}
              >
                Join tournament · {formatPoke(entryFee)}
              </button>
            ) : null}
            <Link className="pa-gen1-back" href="/tournaments">← Back to schedule</Link>
          </div>
        </div>
        <Gen1CupArt />
      </section>

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      {!walletConnected ? (
        <section className="pa-team-file pa-team-empty">
          <p>Connect a wallet to register, watch live matches, or open the bracket.</p>
        </section>
      ) : null}

      {tournament ? (
        <>
          <div className="pa-live-strip">
            <span className={`pa-live-pill${bracketLive ? '' : ''}`}>
              <i /> {tournament.status.toUpperCase()}
            </span>
            <strong>{registeredPlayers.length} / {maxPlayers}</strong>
            <span>{formatPoke(entryFee)} entry</span>
            <span style={{ marginLeft: 'auto', color: '#8ea0c0' }}>
              {tournament.format === 'gen9ou' ? 'GEN 9 OU RULES' : tournament.format.toUpperCase()}
            </span>
          </div>

          {liveMatch ? (
            <section className="pa-live-match">
              <div>
                <span className="pa-live-pill"><i /> LIVE NOW</span>
                <h2>Match in progress</h2>
                <p>
                  <TrainerName playerId={liveMatch.player1} fallback="TBD" /> vs <TrainerName playerId={liveMatch.player2} fallback="TBD" /> · Round {liveMatch.round}
                </p>
              </div>
              <Link className="pa-btn pa-btn-primary" href={`/battle/${liveMatch.id}`}>
                Watch live
              </Link>
            </section>
          ) : null}

          <section className="pa-cup-featured">
            <header>
              <span>Cup funding</span>
              <small>Treasury-backed</small>
            </header>
            <div className="pa-cup-body">
              <div className="pa-cup-funding">
                <div>
                  <small>Entry</small>
                  <b>{formatPoke(entryFee)}</b>
                </div>
                <div>
                  <small>Prize pool</small>
                  <b>{tournament.economics ? formatPoke(tournament.economics.prizePool) : '—'}</b>
                </div>
                <div>
                  <small>Funded by</small>
                  <b>POKEARENA TOURNAMENT TREASURY</b>
                </div>
                <div>
                  <small>Field</small>
                  <b>{maxPlayers} PLAYER CAP</b>
                </div>
              </div>
              {tournament.economics ? (
                <TournamentEconomicsBlock
                  economics={tournament.economics as any}
                  entryFee={entryFee}
                />
              ) : null}
            </div>
            <div className="pa-cup-actions">
              {playerId && tournament.hostId === playerId && (tournament.status === 'registration' || tournament.status === 'ready') ? (
                <button
                  type="button"
                  className="pa-btn pa-btn-primary"
                  disabled={busy}
                  onClick={() => void act(async () => {
                    const response = await client.request({ type: 'tournament.start', tournamentId });
                    if (response.type === 'tournament.state') {
                      setTournament(response.tournament as TournamentDetail);
                    }
                  })}
                >
                  Start tournament
                </button>
              ) : null}
              {myMatch ? (
                <Link className="pa-btn pa-btn-surface" href={`/battle/${myMatch.id}`}>
                  Enter my match
                </Link>
              ) : null}
              {tournament.status === 'completed' ? (
                <Link className="pa-btn pa-btn-primary" href={`/result/${tournament.id}`}>
                  View results
                </Link>
              ) : null}
            </div>
            {!registered && canRegister ? (
              <p className="pa-cup-note">
                {saved?.validated
                  ? `Bringing ${saved.name}`
                  : isDemoAuthEnabled()
                    ? (saved
                      ? 'Draft is not Gen 9 OU legal, so the demo team will be brought.'
                      : 'No saved protocol. The demo team will be brought.')
                    : 'A legal Gen 9 OU team is required to register.'}
              </p>
            ) : null}
          </section>

          <section className="pa-roster">
            <header>
              <h2>Field · {registeredPlayers.length} / {maxPlayers}</h2>
              <span>{registeredPlayers.length >= maxPlayers ? 'FULL' : 'OPEN SLOTS'}</span>
            </header>
            <div className="pa-roster-grid">
              {Array.from({ length: maxPlayers }, (_, index) => {
                const player = registeredPlayers[index];
                return (
                  <div key={index} className={`pa-roster-slot${player ? ' is-filled' : ''}`}>
                    {player ? (
                      <ProfileTrainerSprite label={player.id} side={index % 2 === 0 ? 'left' : 'right'} />
                    ) : (
                      <span className="pa-roster-empty" aria-hidden />
                    )}
                    <div>
                      <b>{player ? <TrainerName playerId={player.id} /> : `Slot ${String(index + 1).padStart(2, '0')}`}</b>
                      <small>{player ? 'Registered' : 'Open'}</small>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="pa-bracket-panel">
            <header>
              <h2>32-player bracket</h2>
              <span>
                {tournament.bracket?.length
                  ? 'Single elimination'
                  : 'Bracket unlocks when the cup starts'}
              </span>
            </header>
            {tournament.bracket?.length ? (
              <BracketView matches={tournament.bracket} maxPlayers={maxPlayers} />
            ) : (
              <p className="pa-empty">
                Round of 32 → Round of 16 → Quarters → Semis → Final → Champion. The board appears after start.
              </p>
            )}
          </section>

          {tournament.winner ? (
            <section className="pa-champion">
              <small>Champion</small>
              <ProfileTrainerSprite label={tournament.winner} side="left" />
              <strong><TrainerName playerId={tournament.winner} /></strong>
            </section>
          ) : null}
        </>
      ) : walletConnected ? (
        <p className="pa-empty">Loading tournament…</p>
      ) : null}
    </div>
  );
}
