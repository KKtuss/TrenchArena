'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { CupIcon, type CupIconName } from '@/components/cup-icons';
import { CupMeter } from '@/components/cup-meter';
import { ErrorToast } from '@/components/error-toast';
import { FormatStage, Gen1CupArt } from '@/components/gen1-cup-art';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { MatchDetailDialog, TournamentBracket } from '@/components/tournament-bracket';
import { useArena } from '@/lib/arena-context';
import { isDemoAuthEnabled } from '@/lib/demo-auth';
import { formatPoke, formatPokeFromAtoms, TOURNAMENT_BURN_FEE_ATOMS } from '@/lib/api-client';
import { sendSerializedTransaction } from '@/lib/solana-tx';
import { battlePaste, readSavedTeam, type SavedTeam } from '@/lib/team';
import { formatById, type FormatPresentation } from '@/lib/tournament-formats';
import { tournamentPrizeView } from '@/lib/tournament-prize';
import {
  TOURNAMENT_ENTRY_POKE,
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
  displayHubStatus,
  formatTimeout,
  isPlayableMatch,
  matchActionLabel,
  playerHubStatus,
  registeredPlayers,
  roundTitles,
  visibleBracket,
  type BracketMatch,
  type HubStatus,
  type PlayerHubKind,
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

const YOU_ICON: Record<PlayerHubKind, CupIconName> = {
  connect: 'lock',
  champion: 'crown',
  complete: 'flag',
  'watching-final': 'trophy',
  live: 'bolt',
  next: 'swords',
  eliminated: 'flag',
  'registered-locked': 'check',
  'registered-waiting': 'check',
  register: 'ticket',
  'waiting-next': 'clock',
  watching: 'users',
};

const BADGE_TONE: Record<HubStatus, string> = {
  LIVE: 'is-live',
  UPCOMING: 'is-info',
  COMPLETED: 'is-gold',
  CANCELLED: 'is-done',
};

function CupArt({ format }: { format?: FormatPresentation }) {
  const backdrop = format?.backdrop ?? '/stages/kanto.webp';
  return (
    <div className="cup-art" style={{ '--cup-art-bg': `url('${backdrop}')` } as CSSProperties}>
      {format ? (
        <span className="cup-art-mark" aria-hidden>
          {format.region}
          <small>{format.restriction}</small>
        </span>
      ) : null}
      {format?.id === 'gen1cup' || !format ? (
        <Gen1CupArt />
      ) : (
        <FormatStage trainer={format.trainer} pokemon={format.pokemon} />
      )}
    </div>
  );
}

type EntryStep = {
  key: string;
  state: 'done' | 'active' | 'todo';
  label: string;
  detail: string;
};

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
  const [boardPreview, setBoardPreview] = useState<'live' | 'champion' | number>('live');
  const [now, setNow] = useState<number | null>(null);
  const [burnPayment, setBurnPayment] = useState<{ intentId: string; signature: string } | null>(null);

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
    if (!burnPayment) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      void client.request({
        type: 'tx.confirm',
        intentId: burnPayment.intentId,
        signature: burnPayment.signature,
      }).then(async response => {
        if (stopped || response.type !== 'tx.update') return;
        if (response.status === 'confirmed') {
          setBurnPayment(null);
          const state = await client.request({ type: 'tournament.subscribe', tournamentId });
          if (!stopped && state.type === 'tournament.state') {
            setTournament(state.tournament as TournamentDetail);
          }
          return;
        }
        if (response.status === 'failed' || response.status === 'expired' || response.status === 'cancelled') {
          setBurnPayment(null);
          setError(response.error ?? 'The burn fee transaction did not confirm.');
        }
      }).catch(err => {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      });
    }, 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [burnPayment, client, tournamentId]);

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
  const burnFeeAtoms = tournament?.rail === 'sol_chain'
    ? (tournament.burnFeeAtoms ?? tournament.entryAtoms ?? TOURNAMENT_BURN_FEE_ATOMS)
    : undefined;
  const burnFeeLabel = burnFeeAtoms === undefined ? undefined : formatPokeFromAtoms(burnFeeAtoms);
  const entryFee = tournament?.entryFee ?? TOURNAMENT_ENTRY_POKE;
  const matches = useMemo(
    () => (tournament ? visibleBracket(tournament) : []),
    [tournament],
  );
  const previewField = (maxPlayers === 4 || maxPlayers === 8 || maxPlayers === 16 || maxPlayers === 32)
    ? maxPlayers
    : 32;
  const previewTournament = useMemo(() => {
    if (!isDemoAuthEnabled() || boardPreview === 'live') return null;
    const viewerId = playerId ?? 'you';
    if (boardPreview === 'champion') {
      return buildMockTournament({ maxPlayers: previewField, champion: true, viewerId });
    }
    return buildMockTournament({
      maxPlayers: previewField,
      currentRound: typeof boardPreview === 'number' ? boardPreview : 1,
      status: 'in-progress',
      viewerId,
    });
  }, [boardPreview, playerId, previewField]);
  const boardMatches = previewTournament?.bracket ?? matches;
  const boardField = previewTournament ? previewField : bracketFieldSize(matches, maxPlayers);
  const badge = displayHubStatus(tournament, matches);
  const boardStatus = previewTournament?.status
    ?? (badge === 'LIVE' && tournament?.status === 'completed' ? 'in-progress' : tournament?.status);
  const liveMatch = findLiveMatch(matches.filter(match => !match.placeholder));
  const myMatch = findPlayerMatch(matches.filter(match => !match.placeholder), playerId);
  const round = currentRound(boardMatches, boardStatus);
  const rounds = roundTitles(boardField);
  const you = tournament ? playerHubStatus(tournament, matches, playerId) : null;
  const canRegister = tournament?.status === 'registration' || tournament?.status === 'draft';
  const projectedPrize = previewTreasuryPrize(entryFee, maxPlayers).prizePool;
  const prizePool = badge === 'UPCOMING'
    ? projectedPrize
    : (tournament?.economics?.prizePool ?? projectedPrize);
  const prize = tournamentPrizeView(tournament, prizePool);
  const chainPrize = prize.chainLabel;
  const prizeLabel = prize.label;
  const { shares, formatShare } = prize;
  const myAction = myMatch ? matchActionLabel(myMatch, playerId) : null;
  const description = tournament
    ? `${formatCard?.title ?? formatName(rulesetId)} · ${formatCard?.region ?? 'Format'} · ${formatCard?.restriction ?? 'Legal'}. ${formatCard?.teamModeLabel ?? 'Custom team'}. ${maxPlayers} trainers. Best of 1.`
    : 'Single elimination cup with a live bracket, compact rules, and a treasury-funded prize.';
  const isCustomTeamTournament = !isCasualPreset;
  const hasLegalSavedTeam = Boolean(saved?.validated && saved.paste.trim());
  const canJoinTournament = isCasualPreset ? true : (!isCustomTeamTournament || hasLegalSavedTeam);
  const accent = formatCard?.accent ?? 'cup';

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

  const observeBurnFee = async (intentId: string, signature: string) => {
    const update = await client.request({
      type: 'tx.confirm',
      intentId,
      signature,
    });
    if (update.type !== 'tx.update') {
      throw new Error('The server did not accept the burn-fee confirmation.');
    }
    if (update.status === 'confirmed') {
      setBurnPayment(null);
      const state = await client.request({ type: 'tournament.subscribe', tournamentId });
      if (state.type === 'tournament.state') setTournament(state.tournament as TournamentDetail);
      return;
    }
    if (update.status === 'pending') {
      setBurnPayment({ intentId, signature });
      return;
    }
    setBurnPayment(null);
    throw new Error(update.error ?? 'The burn fee transaction did not confirm.');
  };

  const payBurnFee = () => void act(async () => {
    if (burnPayment) {
      await observeBurnFee(burnPayment.intentId, burnPayment.signature);
      return;
    }
    if (!walletAdapter) throw new Error('Connect a wallet before paying the burn fee.');
    const response = await client.request({ type: 'tournament.payBurnFee', tournamentId });
    if (response.type !== 'tx.intent') {
      throw new Error('The tournament did not return a burn-fee transaction.');
    }
    if (response.intent.signature && !response.intent.serializedTx?.length) {
      await observeBurnFee(response.intent.intentId, response.intent.signature);
      return;
    }
    if (!response.intent.serializedTx?.length) {
      throw new Error('The tournament did not return a burn-fee transaction.');
    }
    const signature = await sendSerializedTransaction(walletAdapter, response.intent.serializedTx);
    await observeBurnFee(response.intent.intentId, signature);
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
    const fieldFull = players.length >= maxPlayers;

    const steps: EntryStep[] = [
      {
        key: 'wallet',
        state: walletConnected ? 'done' : 'active',
        label: 'Wallet',
        detail: walletConnected ? 'Connected.' : 'Connect a wallet to register.',
      },
      {
        key: 'team',
        state: isCasualPreset || registered || hasLegalSavedTeam ? 'done' : walletConnected ? 'active' : 'todo',
        label: 'Team',
        detail: isCasualPreset
          ? 'Same 6 for both players • Choose 3'
          : registered
            ? 'Submitted with your entry.'
            : hasLegalSavedTeam
              ? `Bringing ${saved?.name ?? 'your saved team'}.`
              : `A legal ${formatCard?.title ?? 'format'} team is required.`,
      },
      {
        key: 'seat',
        state: registered ? 'done' : waitlisted || (walletConnected && canJoinTournament) ? 'active' : 'todo',
        label: 'Seat',
        detail: registered
          ? `Registered · ${players.length} / ${maxPlayers}`
          : waitlisted
            ? 'Waitlisted. Promoted in registration order.'
            : 'Join to take a seat in the field.',
      },
    ];
    if (tournament.rail === 'sol_chain') {
      steps.push({
        key: 'burn',
        state: me?.burnFeePaid ? 'done' : needsBurnFee && paymentOpen ? 'active' : 'todo',
        label: 'Burn fee',
        detail: me?.burnFeePaid ? 'Paid. Your spot is secured.' : `${burnFeeLabel} once the field fills.`,
      });
    }
    if (!isCasualPreset) {
      steps.push({
        key: 'lock',
        state: teamLocked ? 'done' : registered && finalizing ? 'active' : 'todo',
        label: 'Team lock',
        detail: teamLocked
          ? 'Locked. The bracket waits for the shared timer.'
          : finalizing
            ? `Locks in ${lockLabel}.`
            : 'Opens when the field fills.',
      });
    }

    const leaveButtons = (
      <>
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
      </>
    );
    const hasLeave = (registered && !finalizing && tournament.status === 'registration')
      || (registered && finalizing && tournament.rail !== 'sol_chain');

    return (
      <div className={`pa-page cup-page cup-accent-${accent}`}>
        <ErrorToast error={error} onDismiss={() => setError(null)} />

        <nav className="cup-crumbs" aria-label="Tournament">
          <div className="cup-crumbs-left">
            <Link className="cup-back" href="/tournaments"><CupIcon name="arrow-left" />Back to schedule</Link>
            <span className="cup-chip">{formatCard?.title ?? formatName(rulesetId)}</span>
            <span className="cup-chip">{maxPlayers} player</span>
            <span className="cup-chip">Single elimination</span>
          </div>
          <div className="cup-crumbs-right">
            <span className={`cup-pill ${finalizing ? 'is-warn' : 'is-open'}`}>
              <i className="cup-dot is-pulse" aria-hidden />
              {statusLabel}
            </span>
            {registered ? <span className="cup-pill is-you">You're in</span> : null}
          </div>
        </nav>

        <section className="cup-panel is-accent cup-hero">
          <div className="cup-hero-copy">
            <div className="cup-hero-title">
              <span className="cup-hero-mark"><CupIcon name="trophy" /></span>
              <div>
                <span className="cup-kicker">{formatCard ? `${formatCard.region} · ${formatCard.teamModeLabel}` : 'Tournament'}</span>
                <h1 className="cup-title">{tournament.title}</h1>
              </div>
            </div>
            <p className="cup-lead">Prize pool funded by the PokeArena Tournament Treasury.</p>
            <div className="cup-hero-stats">
              <div className="cup-stat">
                <span><CupIcon name="coins" />{tournament.rail === 'sol_chain' ? 'Burn fee after field fills' : 'Entry'}</span>
                <strong>{burnFeeLabel ?? formatPoke(entryFee)}</strong>
              </div>
              <div className="cup-stat is-prize">
                <span><CupIcon name="trophy" />Projected prize</span>
                <strong>{chainPrize ?? formatPoke(signupEconomics.prizePool)}</strong>
              </div>
              <div className="cup-stat">
                <span><CupIcon name="users" />Field</span>
                <strong>{players.length} / {maxPlayers}</strong>
                <CupMeter value={players.length} max={maxPlayers} />
              </div>
            </div>
            <p className="cup-funding">
              <CupIcon name="check" />
              Treasury-backed prize · projected estimate, not immediately withdrawable.
            </p>
            <div className="cup-actions">
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
              {needsBurnFee && paymentOpen ? (
                <button type="button" className="pa-btn pa-btn-gold" disabled={busy} onClick={payBurnFee}>
                  {burnPayment ? 'Check burn fee confirmation' : `Pay burn fee · ${burnFeeLabel}`}
                </button>
              ) : null}
            </div>
            {needsBurnFee && paymentOpen && burnPayment ? (
              <p className="cup-note is-warn">
                <CupIcon name="clock" />
                Burn fee submitted. Waiting for confirmation of the original transaction.
              </p>
            ) : null}
            {waitlisted ? (
              <p className="cup-note">
                <CupIcon name="users" />
                You are on the waitlist and will be promoted in registration order.
              </p>
            ) : null}
            {tournament.rail === 'sol_chain' && registered && me?.burnFeePaid ? (
              <p className="cup-note is-good">
                <CupIcon name="check" />
                Burn fee paid. Your spot is secured while the roster finalizes.
              </p>
            ) : null}
          </div>
          <CupArt format={formatCard} />
        </section>

        {finalizing ? (
          <section className="cup-panel cup-clock" aria-label={`Roster locks in ${lockLabel}`}>
            <div className="cup-clock-label">
              <span><CupIcon name="lock" />Team finalization</span>
              <small>Everyone has the same deadline. The bracket starts when the timer ends.</small>
            </div>
            <strong className="cup-clock-digits">{lockLabel}</strong>
            {registered && !isCasualPreset ? (
              <span className={`cup-pill ${teamLocked ? 'is-open' : 'is-warn'}`}>
                <CupIcon name={teamLocked ? 'lock' : 'clipboard'} />
                {teamLocked ? 'Your team is locked' : 'You can still edit'}
              </span>
            ) : null}
          </section>
        ) : null}

        <div className="cup-lobby-grid">
          <section className="cup-panel">
            <header className="cup-panel-head">
              <h2><CupIcon name="ticket" />Your entry</h2>
              <span>{registered ? "You're in" : waitlisted ? 'Waitlisted' : 'Not registered'}</span>
            </header>
            <ol className="cup-steps">
              {steps.map((step, index) => (
                <li key={step.key} className={`is-${step.state}`}>
                  <i>{step.state === 'done' ? <CupIcon name="check" /> : String(index + 1).padStart(2, '0')}</i>
                  <div>
                    <b>{step.label}</b>
                    <small>{step.detail}</small>
                  </div>
                </li>
              ))}
            </ol>
            {(registered && finalizing && !isCasualPreset) || hasLeave
              || (!registered && walletConnected) ? (
                <div className="cup-lobby-actions">
                  {registered && finalizing && !isCasualPreset ? (
                    !teamLocked ? (
                      <div className="cup-actions">
                        <Link className="pa-btn pa-btn-surface" href={`/teams/builder?ruleset=${rulesetId}&tournament=${tournamentId}`}>
                          Edit team
                        </Link>
                        <button type="button" className="pa-btn pa-btn-surface" disabled={busy || !hasLegalSavedTeam} onClick={pushTeam}>
                          Update entry
                        </button>
                        <button type="button" className="pa-btn pa-btn-gold" disabled={busy} onClick={lockTeam}>
                          Lock team
                        </button>
                      </div>
                    ) : (
                      <p className="cup-note is-good">
                        <CupIcon name="lock" />
                        Locked early. The bracket waits for the shared timer.
                      </p>
                    )
                  ) : null}
                  {hasLeave ? <div className="cup-actions">{leaveButtons}</div> : null}
                  {!registered && walletConnected && isCasualPreset ? (
                    <p className="cup-note"><CupIcon name="users" />Same 6 for both players • Choose 3</p>
                  ) : null}
                  {!registered && walletConnected && !isCasualPreset && hasLegalSavedTeam ? (
                    <p className="cup-note is-good">
                      <CupIcon name="check" />
                      Bringing {saved?.name ?? 'your saved team'}.
                    </p>
                  ) : null}
                  {!registered && walletConnected && !isCasualPreset && !hasLegalSavedTeam ? (
                    <p className="cup-note is-warn">
                      <CupIcon name="clipboard" />
                      <Link href={`/teams/builder?ruleset=${rulesetId}`}>Build a {formatCard?.title ?? 'format'} team</Link>
                    </p>
                  ) : null}
                </div>
              ) : null}
          </section>

          <section className="cup-panel">
            <header className="cup-panel-head">
              <h2><CupIcon name="clipboard" />Cup rules</h2>
              <span>Best of 1</span>
            </header>
            <ul className="cup-rules">
              <li>
                <i><CupIcon name="users" /></i>
                <div>
                  <b>Teams</b>
                  <span>
                    {isCasualPreset
                      ? 'Same 6 for both players • Choose 3. Your three stay hidden until the match starts.'
                      : finalizing
                        ? tournament.rail === 'sol_chain'
                          ? `The field is full. Pay the ${burnFeeLabel} burn fee before the timer ends. Unpaid players are replaced from the waitlist.`
                          : 'The field is full. Five minutes to edit a legal team. Opponent teams stay hidden. The bracket starts when the timer ends.'
                        : `Each match is one ${formatCard?.title ?? formatName(rulesetId)} singles battle. A legal team is required before you can join.`}
                  </span>
                </div>
              </li>
              <li>
                <i><CupIcon name="clock" /></i>
                <div>
                  <b>Timeouts</b>
                  <span>Matches time out after {formatTimeout(tournament.matchTimeoutMs)}. A no-show advances the opponent. Disconnecting grants 10s to reconnect, then a forfeit.</span>
                </div>
              </li>
              <li>
                <i><CupIcon name="coins" /></i>
                <div>
                  <b>Entry</b>
                  <span>
                    {tournament.rail === 'sol_chain'
                      ? `A fixed ${burnFeeLabel} burn fee is paid after the field fills and burned when the final roster locks.`
                      : `The ${formatPoke(entryFee)} entry is held at join. 90% of the field forms the prize pool, paid 50/35/15 when the final and 3rd-place match are done.`}
                  </span>
                </div>
              </li>
            </ul>
          </section>
        </div>

        <section className="cup-panel" aria-label="Field">
          <header className="cup-panel-head cup-seats-head">
            <h2><CupIcon name="users" />Field · {players.length} / {maxPlayers}</h2>
            <CupMeter value={players.length} max={maxPlayers} />
            <span className={`cup-pill ${fieldFull ? 'is-open' : 'is-info'}`}>{fieldFull ? 'FULL' : 'OPEN SLOTS'}</span>
          </header>
          <div className="cup-seats">
            {Array.from({ length: maxPlayers }, (_, index) => {
              const player = players[index];
              const mine = Boolean(player && player.id === playerId);
              return (
                <div
                  key={player?.id ?? `slot-${index}`}
                  className={`cup-seat${player ? ' is-filled' : ' is-open'}${mine ? ' is-you' : ''}`}
                  style={player ? { animationDelay: `${Math.min(index, 24) * 18}ms` } : undefined}
                >
                  {player ? (
                    <ProfileTrainerSprite label={player.id} side={index % 2 === 0 ? 'left' : 'right'} />
                  ) : (
                    <span className="cup-seat-num" aria-hidden>{String(index + 1).padStart(2, '0')}</span>
                  )}
                  <div>
                    <b>{player ? <TrainerName playerId={player.id} /> : `Slot ${String(index + 1).padStart(2, '0')}`}</b>
                    <small>{player ? 'Registered' : 'Open'}</small>
                  </div>
                  {mine ? <span className="cup-pill is-you cup-seat-tag">You</span> : null}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={`pa-page is-cup-hub cup-page cup-accent-${accent}`}>
      <header className="cup-hub-head">
        <nav className="cup-crumbs" aria-label="Tournament">
          <div className="cup-crumbs-left">
            <Link className="cup-back" href="/tournaments"><CupIcon name="arrow-left" />Schedule</Link>
            <span className="cup-chip">{formatCard?.title ?? formatName(rulesetId)}</span>
            <span className="cup-chip">{maxPlayers} players</span>
            <span className="cup-chip">Single elimination</span>
          </div>
        </nav>
        <div className="cup-hub-top">
          <div className="cup-hub-copy">
            <div className="cup-hub-title">
              <h1 className="cup-title">{tournament?.title ?? 'PokeArena Cup'}</h1>
              <span className={`cup-pill ${BADGE_TONE[badge]}`}>
                {badge === 'LIVE' ? <i className="cup-dot is-pulse" aria-hidden /> : null}
                {badge}
              </span>
            </div>
            <p className="cup-lead">{description}</p>
          </div>
          <div className="cup-actions">
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
              <Link className="pa-btn pa-btn-gold" href={`/result/${tournament.id}`}>
                View results
              </Link>
            ) : null}
          </div>
        </div>
        <div className="cup-statline">
          <div>
            <span><CupIcon name="users" />Players</span>
            <strong>{players.length} / {maxPlayers}</strong>
          </div>
          <div>
            <span><CupIcon name="swords" />Round {round} / {rounds.length}</span>
            <strong>{rounds[round - 1] ?? 'Registration'}</strong>
          </div>
          <div className="is-prize">
            <span><CupIcon name="trophy" />Prize pool</span>
            <strong>{prizeLabel}</strong>
          </div>
        </div>
        {you ? (
          <p className={`cup-you is-${you.kind}`}>
            <CupIcon name={YOU_ICON[you.kind]} />
            <span><PlayerStatusCopy kind={you.kind} opponentId={you.opponentId} roundLabel={you.roundLabel} /></span>
          </p>
        ) : null}
      </header>

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      {!walletConnected && canRegister ? (
        <p className="cup-note"><CupIcon name="lock" />Connect a wallet to register. The bracket stays visible.</p>
      ) : null}
      {!registered && canRegister && walletConnected ? (
        <p className="cup-note">
          <CupIcon name="clipboard" />
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
        <div className="cup-hub">
          <section className="cup-panel cup-board" aria-label="Tournament bracket">
            <header className="cup-panel-head">
              <h2><CupIcon name="swords" />Bracket</h2>
              <span>
                {previewTournament ? 'Preview board' : tournament.bracket?.length ? 'Single elimination' : 'Field preview'}
              </span>
            </header>
            <div className="cup-board-body">
              {isDemoAuthEnabled() ? (
                <div className="cup-segment" role="group" aria-label={`Preview a full ${previewField}-player board`}>
                  {([
                    ['live', 'Live'] as const,
                    ...roundTitles(previewField).slice(0, -1).map((label, index) => (
                      [index + 1, previewRoundName(label)] as const
                    )),
                    ['champion', 'Champion'] as const,
                  ]).map(([id, label]) => (
                    <button
                      key={label}
                      type="button"
                      className={boardPreview === id ? 'is-on' : undefined}
                      aria-pressed={boardPreview === id}
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
                <p className="cup-note is-warn">
                  <CupIcon name="clipboard" />
                  Sample board only. The live cup, matches, and prizes are unchanged.
                </p>
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
            </div>
          </section>

          <aside className="cup-aside">
            <section className="cup-panel is-accent cup-prize-panel" aria-label="Prize">
              <div className="cup-prize-card">
                <header>
                  <small><CupIcon name="trophy" />Prize pool</small>
                  <strong>{prizeLabel}</strong>
                </header>
                <ol className="cup-split">
                  {([
                    ['first', '1st', 50, shares?.first],
                    ['second', '2nd', 35, shares?.second],
                    ['third', '3rd', 15, shares?.third],
                  ] as const).map(([key, place, percent, amount]) => (
                    <li key={key} className={`is-${key}`}>
                      <i>{place}</i>
                      <span>{place} place · {percent}%</span>
                      <b>{amount !== undefined ? formatShare(amount) : `${percent}%`}</b>
                      <CupMeter value={percent} max={100} />
                    </li>
                  ))}
                </ol>
              </div>
            </section>

            <section className="cup-panel">
              <header className="cup-panel-head"><h3><CupIcon name="clipboard" />Format</h3></header>
              <dl className="cup-facts">
                <div><dt>Format</dt><dd>{formatCard?.title ?? formatName(rulesetId)}</dd></div>
                <div><dt>Pool</dt><dd>{formatCard?.restriction ?? 'OU legal'}</dd></div>
                <div><dt>Teams</dt><dd>{formatCard?.teamModeLabel ?? 'Custom team'}</dd></div>
                <div><dt>Battle</dt><dd>Singles</dd></div>
                <div><dt>Players</dt><dd>{maxPlayers}</dd></div>
                <div><dt>Bracket</dt><dd>Single elimination</dd></div>
                <div><dt>Match</dt><dd>Best of 1</dd></div>
                <div><dt>Entry</dt><dd>{burnFeeLabel ?? (entryFee > 0 ? formatPoke(entryFee) : 'Treasury entry')}</dd></div>
                <div><dt>Time limit</dt><dd>{formatTimeout(tournament.matchTimeoutMs)}</dd></div>
              </dl>
            </section>

            <section className="cup-panel">
              <header className="cup-panel-head"><h3><CupIcon name="flag" />Rules</h3></header>
              <ul className="cup-rulelist">
                <li>Single elimination. Semifinal losers play one match for 3rd.</li>
                <li>Each match uses the {formatCard?.title ?? 'format'} ruleset on the current battle engine.</li>
                <li>
                  {isCasualPreset
                    ? 'Same 6 for both players • Choose 3. Both trainers see the same six and pick privately.'
                    : `Bring six Pokémon from the ${formatCard?.restriction ?? 'format'} pool. Species stay hidden until team preview.`}
                </li>
                <li>Matches time out after {formatTimeout(tournament.matchTimeoutMs)}. The opponent advances.</li>
                <li>Disconnecting a live fight grants a 10s reconnect window, then a forfeit.</li>
                <li>The cup stays in progress until the final and the 3rd-place match are both decided.</li>
                <li>A no-show is treated as a timeout. The present trainer moves on.</li>
              </ul>
            </section>

            <section className="cup-panel">
              <header className="cup-panel-head">
                <h3><CupIcon name="users" />Field</h3>
                <span>{players.length} / {maxPlayers}</span>
              </header>
              <ul className="cup-field">
                {players.length ? players.map((player, index) => (
                  <li key={player.id} className={player.id === playerId ? 'is-you' : undefined}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <b><TrainerName playerId={player.id} /></b>
                    {player.id === playerId ? <small className="cup-pill is-you">You</small> : null}
                    {tournament.winner === player.id ? <small className="cup-pill is-gold">Champion</small> : null}
                  </li>
                )) : (
                  <li className="is-empty">Waiting for trainers</li>
                )}
              </ul>
            </section>
          </aside>
        </div>
      ) : connected ? (
        <p className="cup-empty">Loading tournament…</p>
      ) : (
        <p className="cup-empty">Connect to load the live cup.</p>
      )}

      <MatchDetailDialog match={selected} viewerId={playerId} maxPlayers={boardField} onClose={() => setSelected(null)} />
    </div>
  );
}

function previewRoundName(label: string): string {
  if (label === 'ROUND OF 32') return 'R32';
  if (label === 'ROUND OF 16') return 'R16';
  if (label === 'QUARTERFINALS') return 'QF';
  if (label === 'SEMIFINALS') return 'SF';
  if (label === 'FINAL') return 'Final';
  return label;
}
