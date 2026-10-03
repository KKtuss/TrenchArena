'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ErrorToast } from '@/components/error-toast';
import { FormatStage, Gen1CupArt } from '@/components/gen1-cup-art';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { MatchDetailDialog, TournamentBracket } from '@/components/tournament-bracket';
import { useArena } from '@/lib/arena-context';
import { isDemoAuthEnabled } from '@/lib/demo-auth';
import { formatPoke, formatSolLamports } from '@/lib/api-client';
import { sendSerializedTransaction } from '@/lib/solana-tx';
import { battlePaste, readSavedTeam, type SavedTeam } from '@/lib/team';
import { formatById } from '@/lib/tournament-formats';
import {
  TOURNAMENT_ENTRY_POKE,
  TOURNAMENT_BURN_FEE_POKE,
  TOURNAMENT_FIELD_SIZE,
  formatCountdown,
  previewTreasuryPrize,
} from '@/lib/tournament-schedule';
import {
  bracketFieldSize,
  buildMockTournament,
  currentRound,
  findLiveMatch,
  findPlayerMatch,
  formatName,
  formatTimeout,
  hubStatus,
  isPlayableMatch,
  matchActionLabel,
  playerHubStatus,
  registeredPlayers,
  roundTitles,
  visibleBracket,
  type BracketMatch,
  type TournamentDetail,
} from '@/lib/tournament-hub';

function PlayerStatusCopy({
  kind,
  opponentId,
  roundLabel,
}: {
  kind: ReturnType<typeof playerHubStatus>['kind'];
  opponentId?: string;
  roundLabel?: string;
}) {
  if (kind === 'connect') return <>Connect a wallet to follow your path.</>;
  if (kind === 'champion') return <>You won the cup.</>;
  if (kind === 'complete') return <>Tournament complete.</>;
  if (kind === 'watching-final') return <>Watching the final bracket.</>;
  if (kind === 'live') {
    return opponentId
      ? <>You're live vs. <TrainerName playerId={opponentId} /></>
      : <>Your match is live.</>;
  }
  if (kind === 'next') {
    return opponentId
      ? <>Your next match: vs. <TrainerName playerId={opponentId} /></>
      : <>Your next match is waiting.</>;
  }
  if (kind === 'eliminated') return <>Eliminated · {roundLabel}</>;
  if (kind === 'registered-locked') return <>You're in · bracket locked.</>;
  if (kind === 'registered-waiting') return <>You're in · waiting for the field.</>;
  if (kind === 'register') return <>Register to enter the bracket.</>;
  if (kind === 'waiting-next') return <>Waiting for your next match.</>;
  return <>Watching the bracket.</>;
}

function SignupIcon({
  name,
}: {
  name: 'trophy' | 'coins' | 'users' | 'check' | 'clipboard' | 'clock';
}) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {name === 'trophy' ? (
        <>
          <path d="M8 21h8" />
          <path d="M12 17v4" />
          <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
          <path d="M17 8h1.5a3 3 0 0 0 0-6H17" />
          <path d="M7 8H5.5a3 3 0 0 1 0-6H7" />
        </>
      ) : null}
      {name === 'coins' ? (
        <>
          <ellipse cx="9" cy="15" rx="6" ry="5.2" />
          <ellipse cx="15" cy="9.2" rx="6" ry="5.2" />
        </>
      ) : null}
      {name === 'users' ? (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      ) : null}
      {name === 'check' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.2 2.4 2.4 4.6-5.1" />
        </>
      ) : null}
      {name === 'clipboard' ? (
        <>
          <rect x="8" y="2.5" width="8" height="3.5" rx="1" />
          <path d="M16 4.2h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.2a2 2 0 0 1 2-2h2" />
        </>
      ) : null}
      {name === 'clock' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3.2 2" />
        </>
      ) : null}
    </svg>
  );
}

export default function TournamentDetailPage() {
  const params = useParams<{ id: string }>();
  const tournamentId = params?.id ?? '';
  const {
    client,
    playerId,
    connected,
    walletConnected,
    walletAdapter,
    connectInjectedWallet,
    connectingWallet,
  } = useArena();
  const [tournament, setTournament] = useState<TournamentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedTeam | null>(null);
  const [selected, setSelected] = useState<BracketMatch | null>(null);
  const [boardPreview, setBoardPreview] = useState<'live' | 1 | 2 | 3 | 4 | 'champion'>('live');
  const [now, setNow] = useState<number | null>(null);

  const rulesetId = tournament?.ruleset || tournament?.format || 'gen9ou';
  const formatCard = formatById(rulesetId);
  const isCasualPreset = formatCard?.teamMode === 'preset-6-choose-3';

  useEffect(() => {
    setSaved(playerId ? readSavedTeam(playerId, rulesetId) : null);
  }, [playerId, rulesetId]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected) return;
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
  }, [client, connected, tournamentId]);

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

  const players = registeredPlayers(tournament);
  const me = tournament?.players?.find(player => player.id === playerId);
  const registered = me?.status === 'registered';
  const waitlisted = me?.status === 'waitlisted';
  const maxPlayers = tournament?.maxPlayers ?? TOURNAMENT_FIELD_SIZE;
  const burnFee = tournament?.burnFeeAtoms ?? TOURNAMENT_BURN_FEE_POKE;
  const entryFee = tournament?.rail === 'sol_chain'
    ? burnFee
    : (tournament?.entryFee ?? TOURNAMENT_ENTRY_POKE);
  const matches = useMemo(
    () => (tournament ? visibleBracket(tournament) : []),
    [tournament],
  );
  const previewTournament = useMemo(() => {
    if (!isDemoAuthEnabled() || boardPreview === 'live') return null;
    const viewerId = playerId ?? 'you';
    if (boardPreview === 'champion') {
      return buildMockTournament({ maxPlayers: 32, champion: true, viewerId });
    }
    return buildMockTournament({
      maxPlayers: 32,
      currentRound: boardPreview,
      status: 'in-progress',
      viewerId,
    });
  }, [boardPreview, playerId]);
  const boardMatches = previewTournament?.bracket ?? matches;
  const boardField = previewTournament ? 32 : bracketFieldSize(matches, maxPlayers);
  const boardStatus = previewTournament?.status ?? tournament?.status;
  const liveMatch = findLiveMatch(matches.filter(match => !match.placeholder));
  const myMatch = findPlayerMatch(matches.filter(match => !match.placeholder), playerId);
  const badge = hubStatus(tournament?.status);
  const round = currentRound(boardMatches, boardStatus);
  const rounds = roundTitles(boardField);
  const you = tournament ? playerHubStatus(tournament, matches, playerId) : null;
  const canRegister = tournament?.status === 'registration' || tournament?.status === 'draft';
  const projectedPrize = previewTreasuryPrize(entryFee, maxPlayers).prizePool;
  const prizePool = badge === 'UPCOMING'
    ? projectedPrize
    : (tournament?.economics?.prizePool ?? projectedPrize);
  const chainPrize = tournament?.rail === 'sol_chain' && tournament.prizeLamports !== undefined
    ? formatSolLamports(tournament.prizeLamports)
    : undefined;
  const prizeLabel = chainPrize ?? formatPoke(prizePool);
  const myAction = myMatch ? matchActionLabel(myMatch, playerId) : null;
  const description = tournament
    ? `${formatCard?.title ?? formatName(rulesetId)} · ${formatCard?.region ?? 'Format'} · ${formatCard?.restriction ?? 'Legal'}. ${formatCard?.teamModeLabel ?? 'Custom team'}. ${maxPlayers} trainers. Best of 1.`
    : 'Single elimination cup with a live bracket, compact rules, and a treasury-funded prize.';
  const isCustomTeamTournament = !isCasualPreset;
  const hasLegalSavedTeam = Boolean(saved?.validated && saved.paste.trim());
  const canJoinTournament = isCasualPreset ? true : (!isCustomTeamTournament || hasLegalSavedTeam);

  const joinCup = () => void act(async () => {
    if (!playerId) throw new Error('Connect a wallet before joining.');
    if (isCustomTeamTournament && !hasLegalSavedTeam) {
      throw new Error('No legal saved team for this format.');
    }
    const paste = isCasualPreset ? undefined : battlePaste(playerId, rulesetId);
    const response = await client.request({
      type: 'tournament.join',
      tournamentId,
      ...(paste ? { team: paste } : {}),
    });
    if (response.type === 'tournament.state') {
      setTournament(response.tournament as TournamentDetail);
    }
  });

  const payBurnFee = () => void act(async () => {
    if (!walletAdapter) throw new Error('Connect a wallet before paying the burn fee.');
    const response = await client.request({ type: 'tournament.payBurnFee', tournamentId });
    if (response.type !== 'tx.intent' || !response.intent.serializedTx) {
      throw new Error('The tournament did not return a burn-fee transaction.');
    }
    const signature = await sendSerializedTransaction(walletAdapter, response.intent.serializedTx);
    await client.request({
      type: 'tx.confirm',
      intentId: response.intent.intentId,
      signature,
    });
    const state = await client.request({ type: 'tournament.subscribe', tournamentId });
    if (state.type === 'tournament.state') setTournament(state.tournament as TournamentDetail);
  });

  const pushTeam = () => void act(async () => {
    if (!saved?.validated || !saved.paste.trim()) {
      throw new Error('Save a legal team for this format before updating your entry.');
    }
    const response = await client.request({
      type: 'tournament.updateTeam',
      tournamentId,
      team: saved.paste,
    });
    if (response.type === 'tournament.state') setTournament(response.tournament as TournamentDetail);
  });

  const lockTeam = () => void act(async () => {
    const response = await client.request({ type: 'tournament.lockTeam', tournamentId });
    if (response.type === 'tournament.state') setTournament(response.tournament as TournamentDetail);
  });

  const leaveCup = () => void act(async () => {
    const response = await client.request({ type: 'tournament.leave', tournamentId });
    if (response.type === 'tournament.state') setTournament(response.tournament as TournamentDetail);
  });

  if (tournament && canRegister) {
    const signupEconomics = previewTreasuryPrize(
      entryFee,
      tournament.economics?.playerCount ?? Math.max(players.length, 1),
    );
    const finalizing = tournament.finalizesAt != null && (now == null || now < tournament.finalizesAt);
    const teamLocked = Boolean(me?.teamLocked);
    const paymentOpen = tournament.rail === 'sol_chain'
      && tournament.finalizesAt != null
      && (now == null || now < tournament.finalizesAt);
    const needsBurnFee = tournament.rail === 'sol_chain'
      && me?.status === 'registered'
      && !me.burnFeePaid;
    const statusLabel = finalizing ? 'FINALIZING' : tournament.status.toUpperCase();
    const lockLabel = tournament.finalizesAt == null || now == null
      ? '--:--'
      : formatCountdown(tournament.finalizesAt, now);
    return (
      <div className="pa-page">
        <ErrorToast error={error} onDismiss={() => setError(null)} />
        <section className="pa-signup">
          <div className="pa-signup-rail">
            <div className="pa-signup-rail-identity">
              <span>{formatCard?.title ?? formatName(rulesetId)}</span>
              <i aria-hidden />
              <span>{maxPlayers} PLAYER</span>
              <i aria-hidden />
              <span>SINGLE ELIMINATION</span>
            </div>
            <div className="pa-signup-rail-status">
              <i aria-hidden />
              <span>{statusLabel}</span>
              {registered ? <span>· YOU'RE IN</span> : null}
              <Link className="pa-signup-back" href="/tournaments">← Back to schedule</Link>
            </div>
          </div>
          <div className="pa-signup-top">
            <div className="pa-signup-copy">
              <div className="pa-signup-identity">
                <span className="pa-signup-mark"><SignupIcon name="trophy" /></span>
                <div>
                  <h1>{tournament.title}</h1>
                  <p className="pa-lead">
                    Prize pool funded by the PokeArena Tournament Treasury.
                  </p>
                </div>
              </div>
              <div className="pa-signup-stats">
                <div className="pa-signup-stat">
                  <span className="pa-signup-stat-icon"><SignupIcon name="coins" /></span>
                  <div>
                    <span>{tournament.rail === 'sol_chain' ? 'Burn fee after field fills' : 'Entry'}</span>
                    <strong>{formatPoke(entryFee)}</strong>
                  </div>
                </div>
                <div className="pa-signup-stat is-prize">
                  <span className="pa-signup-stat-icon"><SignupIcon name="trophy" /></span>
                  <div>
                    <span>Projected prize</span>
                    <strong>{chainPrize ?? formatPoke(signupEconomics.prizePool)}</strong>
                  </div>
                </div>
                <div className="pa-signup-stat">
                  <span className="pa-signup-stat-icon"><SignupIcon name="users" /></span>
                  <div>
                    <span>Field</span>
                    <strong>{players.length} / {maxPlayers}</strong>
                  </div>
                </div>
              </div>
              <p className="pa-signup-funding">
                <SignupIcon name="check" />
                Treasury-backed prize · projected estimate, not immediately withdrawable.
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
                ) : !registered && !waitlisted && canJoinTournament ? (
                  <button
                    type="button"
                    className="pa-btn pa-btn-primary"
                    disabled={busy}
                    onClick={joinCup}
                  >
                    Join tournament
                  </button>
                ) : !registered && !waitlisted && !isCasualPreset ? (
                  <Link className="pa-btn pa-btn-primary" href={`/teams/builder?ruleset=${rulesetId}`}>
                    {rulesetId === 'gen9ou' ? 'Build Gen 9 OU Team' : `Build Gen ${formatCard?.generation ?? ''} Team`}
                  </Link>
                ) : !registered && !waitlisted ? (
                  <button type="button" className="pa-btn pa-btn-primary" disabled>
                    Choose 3 from the shared six
                  </button>
                ) : null}
                {waitlisted ? (
                  <p className="pa-cup-note">You are on the waitlist and will be promoted in registration order.</p>
                ) : null}
                {needsBurnFee && paymentOpen ? (
                  <button type="button" className="pa-btn pa-btn-gold" disabled={busy} onClick={payBurnFee}>
                    Pay burn fee · {formatPoke(burnFee)}
                  </button>
                ) : null}
                {tournament.rail === 'sol_chain' && registered && me?.burnFeePaid ? (
                  <p className="pa-cup-note">Burn fee paid. Your spot is secured while the roster finalizes.</p>
                ) : null}
                {registered && finalizing && !isCasualPreset ? (
                  <>
                    <p className="pa-cup-note">
                      Team finalization · locks in {lockLabel}. Everyone has the same deadline.
                      {teamLocked ? ' Your team is locked.' : ' You can still edit.'}
                    </p>
                    {!teamLocked ? (
                      <>
                        <Link className="pa-btn pa-btn-surface" href={`/teams/builder?ruleset=${rulesetId}&tournament=${tournamentId}`}>
                          Edit team
                        </Link>
                        <button type="button" className="pa-btn pa-btn-surface" disabled={busy || !hasLegalSavedTeam} onClick={pushTeam}>
                          Update entry
                        </button>
                        <button type="button" className="pa-btn pa-btn-gold" disabled={busy} onClick={lockTeam}>
                          Lock team
                        </button>
                      </>
                    ) : (
                      <p className="pa-cup-note">Locked early. The bracket waits for the shared timer.</p>
                    )}
                  </>
                ) : null}
                {registered && !finalizing && tournament.status === 'registration' ? (
                  <button type="button" className="pa-btn pa-btn-surface" disabled={busy} onClick={leaveCup}>
                    Leave tournament
                  </button>
                ) : null}
                {registered && finalizing && tournament.rail !== 'sol_chain' ? (
                  <button type="button" className="pa-btn pa-btn-surface" disabled={busy} onClick={leaveCup}>
                    Leave before lock
                  </button>
                ) : null}
                {!registered && walletConnected && isCasualPreset ? (
                  <p className="pa-cup-note">Same 6 for both players • Choose 3</p>
                ) : null}
                {!registered && walletConnected && !isCasualPreset && hasLegalSavedTeam ? (
                  <p className="pa-cup-note">
                    Bringing {saved?.name ?? 'your saved team'}.
                  </p>
                ) : null}
                {!registered && walletConnected && !isCasualPreset && !hasLegalSavedTeam ? (
                  <p className="pa-cup-note">
                    <Link href={`/teams/builder?ruleset=${rulesetId}`}>Build a {formatCard?.title ?? 'format'} team</Link>
                  </p>
                ) : null}
              </div>
            </div>
            <div className="pa-signup-side">
              <div className="pa-signup-meta">
                <div className="pa-signup-rules-panel">
                  <header>
                    <SignupIcon name="clipboard" />
                    Cup rules
                  </header>
                  <ul className="pa-signup-rules">
                    <li>
                      <strong><SignupIcon name="users" /> Teams</strong>
                      <span>
                        {isCasualPreset
                          ? 'Same 6 for both players • Choose 3. Your three stay hidden until the match starts.'
                          : finalizing
                            ? tournament.rail === 'sol_chain'
                              ? `The field is full. Pay the ${formatPoke(burnFee)} burn fee before the timer ends. Unpaid players are replaced from the waitlist.`
                              : 'The field is full. Five minutes to edit a legal team. Opponent teams stay hidden. The bracket starts when the timer ends.'
                            : `Each match is one ${formatCard?.title ?? formatName(rulesetId)} singles battle. A legal team is required before you can join.`}
                      </span>
                    </li>
                    <li>
                      <strong><SignupIcon name="clock" /> Timeouts</strong>
                      <span>Matches time out after {formatTimeout(tournament.matchTimeoutMs)}. A no-show advances the opponent. Disconnecting grants 10s to reconnect, then a forfeit.</span>
                    </li>
                    <li>
                      <strong><SignupIcon name="coins" /> Entry</strong>
                      <span>
                        {tournament.rail === 'sol_chain'
                          ? `A fixed ${formatPoke(burnFee)} burn fee is paid after the field fills and burned when the final roster locks.`
                          : `The ${formatPoke(entryFee)} entry is held at join and settles into the champion prize (90%) when the cup completes.`}
                      </span>
                    </li>
                  </ul>
                </div>
              </div>
              <div className="pa-signup-art">
                {formatCard?.id === 'gen1cup' || !formatCard ? (
                  <Gen1CupArt />
                ) : (
                  <FormatStage trainer={formatCard.trainer} pokemon={formatCard.pokemon} />
                )}
              </div>
            </div>
          </div>
          <div className="pa-signup-field">
            <header>
              <h2><SignupIcon name="users" /> Field · {players.length} / {maxPlayers}</h2>
              <span>{players.length >= maxPlayers ? 'FULL' : 'OPEN SLOTS'}</span>
            </header>
            <div className="pa-roster-grid">
              {Array.from({ length: maxPlayers }, (_, index) => {
                const player = players[index];
                return (
                  <div key={player?.id ?? `slot-${index}`} className={`pa-roster-slot${player ? ' is-filled' : ''}`}>
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
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="pa-page is-cup-hub">
      <header className="pa-cup-head">
        <div className="pa-cup-head-copy">
          <div className="pa-cup-title-row">
            <h1>{tournament?.title ?? 'PokeArena Cup'}</h1>
            <span className={`pa-cup-badge is-${badge.toLowerCase()}`}>{badge}</span>
          </div>
          <p className="pa-lead">{description}</p>
          <p className="pa-cup-meta">
            <span>{players.length} / {maxPlayers} players</span>
            <i aria-hidden />
            <span>Round {round} / {rounds.length} · {rounds[round - 1] ?? 'Registration'}</span>
            <i aria-hidden />
            <span>{prizeLabel}</span>
          </p>
          {you ? (
            <p className={`pa-cup-you is-${you.kind}`}>
              <PlayerStatusCopy kind={you.kind} opponentId={you.opponentId} roundLabel={you.roundLabel} />
            </p>
          ) : null}
        </div>
        <div className="pa-cup-head-actions">
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
              onClick={joinCup}
            >
              {tournament?.rail === 'sol_chain' ? 'Join tournament' : `Join · ${formatPoke(entryFee)}`}
            </button>
          ) : null}
          {myMatch && myAction ? (
            <Link
              className={isPlayableMatch(myMatch.status) ? 'pa-btn pa-btn-primary' : 'pa-btn pa-btn-surface'}
              href={`/battle/${myMatch.id}`}
            >
              {myAction}
            </Link>
          ) : liveMatch ? (
            <Link className="pa-btn pa-btn-surface" href={`/battle/${liveMatch.id}`}>
              Watch live
            </Link>
          ) : null}
          {tournament?.status === 'completed' ? (
            <Link className="pa-btn pa-btn-surface" href={`/result/${tournament.id}`}>
              View results
            </Link>
          ) : null}
          <Link className="pa-gen1-back" href="/tournaments">← Schedule</Link>
        </div>
      </header>

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      {!walletConnected && canRegister ? (
        <p className="pa-cup-note">Connect a wallet to register. The bracket stays visible.</p>
      ) : null}
      {!registered && canRegister && walletConnected ? (
        <p className="pa-cup-note">
              {isCasualPreset
                ? 'Tournament entry is open. Each fight opens a private 6 → 3 pick when the bracket reaches your round.'
                : saved?.validated
                  ? `Bringing ${saved.name}`
                  : rulesetId === 'gen9ou' && isDemoAuthEnabled()
                    ? (saved
                      ? 'Draft is not Gen 9 OU legal, so the demo team will be brought.'
                      : 'No saved protocol. The demo team will be brought.')
                    : `A legal ${formatCard?.title ?? 'format'} team is required to register.`}
        </p>
      ) : null}

      {tournament ? (
        <div className="pa-cup-layout">
          <section className="pa-tree-panel" aria-label="Tournament bracket">
            <header>
              <h2>Bracket</h2>
              <span>
                {previewTournament ? 'Preview board' : tournament.bracket?.length ? 'Single elimination' : 'Field preview'}
              </span>
            </header>
            {isDemoAuthEnabled() ? (
              <div className="pa-board-preview" role="group" aria-label="Preview a full 32-player board">
                {([
                  ['live', 'Live'],
                  [1, 'R32'],
                  [2, 'R16'],
                  [3, 'QF'],
                  [4, 'SF'],
                  ['champion', 'Champion'],
                ] as const).map(([id, label]) => (
                  <button
                    key={label}
                    type="button"
                    className={boardPreview === id ? 'is-on' : undefined}
                    onClick={() => {
                      setSelected(null);
                      setBoardPreview(id);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            {previewTournament ? (
              <p className="pa-board-preview-note">Sample board only. The live cup, matches, and prizes are unchanged.</p>
            ) : null}
            <TournamentBracket
              matches={boardMatches}
              maxPlayers={boardField}
              viewerId={playerId}
              winner={previewTournament ? previewTournament.winner : tournament.winner}
              status={boardStatus}
              selectedId={selected?.id}
              onSelect={match => {
                if (previewTournament || match.placeholder) return;
                setSelected(match);
              }}
            />
          </section>

          <aside className="pa-cup-aside">
            <section className="pa-cup-info">
              <header>Format</header>
              <dl className="pa-cup-facts">
                <div><dt>Format</dt><dd>{formatCard?.title ?? formatName(rulesetId)}</dd></div>
                <div><dt>Pool</dt><dd>{formatCard?.restriction ?? 'OU legal'}</dd></div>
                <div><dt>Teams</dt><dd>{formatCard?.teamModeLabel ?? 'Custom team'}</dd></div>
                <div><dt>Battle</dt><dd>Singles</dd></div>
                <div><dt>Players</dt><dd>{maxPlayers}</dd></div>
                <div><dt>Bracket</dt><dd>Single elimination</dd></div>
                <div><dt>Match</dt><dd>Best of 1</dd></div>
                <div><dt>Entry</dt><dd>{entryFee > 0 ? formatPoke(entryFee) : 'Treasury entry'}</dd></div>
                <div><dt>Prize pool</dt><dd>{prizeLabel}</dd></div>
                <div><dt>Time limit</dt><dd>{formatTimeout(tournament.matchTimeoutMs)}</dd></div>
              </dl>
            </section>

            <section className="pa-cup-info">
              <header>Rules</header>
              <ul className="pa-cup-rules">
                <li>Single elimination. Lose once and you are out.</li>
                <li>Each match uses the {formatCard?.title ?? 'format'} ruleset on the current battle engine.</li>
                <li>
                  {isCasualPreset
                    ? 'Same 6 for both players • Choose 3. Both trainers see the same six and pick privately.'
                    : `Bring six Pokémon from the ${formatCard?.restriction ?? 'format'} pool. Species stay hidden until team preview.`}
                </li>
                <li>Matches time out after {formatTimeout(tournament.matchTimeoutMs)}. The opponent advances.</li>
                <li>Disconnecting a live fight grants a 10s reconnect window, then a forfeit.</li>
                <li>Winners are seeded into the next round until a champion is crowned.</li>
                <li>A no-show is treated as a timeout. The present trainer moves on.</li>
              </ul>
            </section>

            <section className="pa-cup-info">
              <header>Field · {players.length} / {maxPlayers}</header>
              <ul className="pa-cup-field">
                {players.length ? players.map(player => (
                  <li key={player.id}>
                    <TrainerName playerId={player.id} />
                    {player.id === playerId ? <small>You</small> : null}
                    {tournament.winner === player.id ? <small>Champion</small> : null}
                  </li>
                )) : (
                  <li className="is-empty">Waiting for trainers</li>
                )}
              </ul>
            </section>
          </aside>
        </div>
      ) : connected ? (
        <p className="pa-empty">Loading tournament…</p>
      ) : (
        <p className="pa-empty">Connect to load the live cup.</p>
      )}

      <MatchDetailDialog match={selected} viewerId={playerId} onClose={() => setSelected(null)} />
    </div>
  );
}
