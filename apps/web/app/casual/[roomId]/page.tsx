'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { CASUAL_BATTLE_HANDOFF_MS, CasualBattleReveal, CasualSelectBoard } from '@/components/casual-select';
import { TeamStrip } from '@/components/showdown-visuals';
import { ProfileTrainerSprite, TrainerName } from '@/components/profile-trainer';
import { useArena } from '@/lib/arena-context';
import { shouldEnterLiveBattle } from '@/lib/battle-entry';
import { formatPoke, formatSolLamports } from '@/lib/api-client';
import type { CasualRoom } from '@/lib/protocol';
import { formatCasualRoomLabel } from '@/lib/protocol';
import { battlePaste, readSavedTeam, type SavedTeam } from '@/lib/team';

function formatLabel(room: CasualRoom): string {
  return formatCasualRoomLabel(room).toUpperCase();
}

function lobbyNote(input: {
  room: CasualRoom;
  competitive: boolean;
  countingDown: boolean;
  countdownLeft: number;
  youReady: boolean;
  rivalReady: boolean;
}): string {
  const {
    room,
    competitive,
    countingDown,
    countdownLeft,
    youReady,
    rivalReady,
  } = input;
  if (room.battleSize === '2v2') return '2v2 rooms can be configured, but starts are not live yet.';
  if (room.status === 'cancelled') return 'This challenge was cancelled.';
  if (competitive) {
    if (!room.opponentId) return 'Waiting for a rival. Keep your Gen 9 OU team ready — nothing is revealed yet.';
    if (youReady && rivalReady) {
      return countingDown && countdownLeft > 0
        ? `Both trainers locked. Battle starts in ${countdownLeft}.`
        : 'Both trainers locked. Starting the fight.';
    }
    if (youReady) return 'You locked your six. Waiting for the rival to ready up.';
    return 'Lock the active team from My Teams. The rival cannot see your paste.';
  }
  if (!room.opponentId) {
    return 'Waiting for a rival. Ready up once they join.';
  }
  if (youReady && rivalReady) {
    return countingDown && countdownLeft > 0
      ? 'Both trainers ready. The match is starting.'
      : 'Both trainers ready. Choose your three.';
  }
  if (youReady) return 'You are ready. Waiting for the rival to ready up.';
  return 'Ready up. Selection opens when both trainers are ready.';
}

function sideReadyLabel(input: {
  isYou: boolean;
  hasRival: boolean;
  competitive: boolean;
  drafting: boolean;
  ready: boolean;
  waitingForJoin: boolean;
}): string {
  const { isYou, hasRival, competitive, drafting, ready, waitingForJoin } = input;
  if (!isYou && !hasRival) return 'Open queue';
  if (drafting) return ready ? 'Locked' : 'Picking';
  if (competitive) return ready ? 'Locked' : (isYou ? 'Team pending' : 'Joined');
  if (waitingForJoin) return 'Waiting';
  return ready ? 'Ready' : (isYou ? 'Not ready' : 'Joined');
}

export default function CasualRoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = params?.roomId ?? '';
  const { client, playerId, connected, snapshot, walletAdapter } = useArena();
  const router = useRouter();
  const [room, setRoom] = useState<CasualRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [acceptArmed, setAcceptArmed] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [savedTeam, setSavedTeam] = useState<SavedTeam | null>(null);
  const [starterPaste, setStarterPaste] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const startRequested = useRef(false);
  const cameFromSelect = useRef(false);
  const battleHandoff = useRef(false);

  useEffect(() => {
    setSavedTeam(playerId ? readSavedTeam(playerId) : null);
  }, [playerId]);

  useEffect(() => {
    if (room) return;
    const restored = snapshot?.myCasualRooms.find(item => item.id === roomId);
    if (restored) setRoom(restored);
  }, [room, roomId, snapshot]);

  useEffect(() => {
    if (!connected) return;
    const unsubscribe = client.onMessage(message => {
      if ((message.type === 'casual.state' || message.type === 'casual.created') && message.room.id === roomId) {
        setRoom(message.room);
      }
      if (message.type === 'casual.result' && message.room.id === roomId) {
        setRoom(message.room);
      }
    });
    void client.request({ type: 'casual.subscribe', roomId }).then(response => {
      if (response.type === 'casual.state') setRoom(response.room);
    }).catch(err => setError(err instanceof Error ? err.message : String(err)));
    return unsubscribe;
  }, [client, connected, roomId]);

  const youAreCreator = Boolean(room && playerId && room.creatorId === playerId);
  const yours = useMemo(
    () => room?.teamPreview?.find(preview => preview.playerId === playerId),
    [playerId, room],
  );
  const rivalPreview = useMemo(
    () => room?.teamPreview?.find(preview => preview.playerId !== playerId),
    [playerId, room],
  );

  useEffect(() => {
    setSelected(yours?.selectedSlots ?? []);
  }, [yours?.presetId, yours?.selectedSlots?.join(',')]);

  const isPlayer = Boolean(room && playerId && (room.creatorId === playerId || room.opponentId === playerId));
  const real = room?.rail === 'sol_chain';
  const canAccept = Boolean(
    room && playerId && room.creatorId !== playerId
    && !room.opponentId
    && (room.status === 'open' || (real && room.status === 'pending_deposit'))
    && (!room.invitedPlayerId || room.invitedPlayerId === playerId),
  );
  const money = (amount: number) => real ? formatSolLamports(amount) : formatPoke(amount);
  const myDeposit = Boolean(playerId && room && (
    playerId === room.creatorId ? room.deposits?.creator : room.deposits?.opponent
  ));
  const stakesLocked = Boolean(real && room?.deposits?.creator && room.deposits.opponent);
  const needsStake = Boolean(real && isPlayer && !myDeposit && room && room.status !== 'completed' && room.status !== 'cancelled' && room.status !== 'battling');

  const lockReturnedStake = async (response: { type: string; intent?: { intentId: string; serializedTx?: number[] } }) => {
    if (response.type !== 'tx.intent' || !response.intent?.serializedTx?.length) return;
    if (!walletAdapter) throw new Error('Connect the wallet that must sign this stake.');
    const { sendSerializedTransaction } = await import('@/lib/solana-tx');
    const signature = await sendSerializedTransaction(walletAdapter, response.intent.serializedTx);
    await client.request({
      type: 'tx.confirm',
      intentId: response.intent.intentId,
      signature,
    });
  };

  const yourId = room
    ? (youAreCreator ? room.creatorId : (room.opponentId ?? playerId ?? 'You'))
    : (playerId ?? 'You');
  const rivalId = room
    ? (youAreCreator ? room.opponentId : room.creatorId)
    : undefined;
  const youReady = Boolean(playerId && room?.ready[playerId]);
  const rivalReady = Boolean(room && rivalId ? room.ready[rivalId] : false);
  const casualSelect = Boolean(room && (room.ruleset ?? 'casual') === 'casual' && room.battleSize === '1v1');
  const competitive = Boolean(room && room.ruleset === 'competitive' && room.battleSize === '1v1');
  const drafting = Boolean(casualSelect && room?.status === 'drafting');
  const ownPaste = (playerId ? battlePaste(playerId) : undefined) ?? starterPaste;
  const canLockCompetitive = Boolean(ownPaste);
  const countdownEndsAt = !casualSelect && room?.status === 'ready' && room.battleSize === '1v1'
    ? room.countdownEndsAt
    : undefined;
  const countdownLeft = countdownEndsAt
    ? Math.max(0, Math.ceil((countdownEndsAt - clock) / 1000))
    : 0;
  const countingDown = Boolean(countdownEndsAt);
  const selectionEndsAt = drafting ? room?.selectionEndsAt : undefined;
  const selectionLeft = selectionEndsAt
    ? Math.max(0, Math.ceil((selectionEndsAt - clock) / 1000))
    : null;
  const bothLocked = Boolean(drafting && yours?.confirmed && rivalPreview?.confirmed);
  if (drafting) cameFromSelect.current = true;
  const revealBattle = Boolean(
    casualSelect
    && room
    && shouldEnterLiveBattle(room, playerId)
    && cameFromSelect.current,
  );

  useEffect(() => {
    if (!countdownEndsAt && !selectionEndsAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [countdownEndsAt, selectionEndsAt]);

  useEffect(() => {
    startRequested.current = false;
  }, [room?.status]);

  useEffect(() => {
    if (!connected || !competitive || savedTeam?.validated) return;
    let cancelled = false;
    void client.request({ type: 'team.starter' }).then(response => {
      if (!cancelled && response.type === 'team.starter') setStarterPaste(response.paste);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, connected, competitive, savedTeam?.validated]);

  useEffect(() => {
    if (!room || !isPlayer || room.battleSize !== '1v1') return;
    const countdownPending = Boolean(room.countdownEndsAt && clock < room.countdownEndsAt);
    const shouldAdvanceReady = room.status === 'ready' && !countdownPending;
    if (!shouldAdvanceReady) return;
    if (startRequested.current || busy) return;
    startRequested.current = true;
    void client.request({ type: 'casual.start', roomId }).then(response => {
      if (response.type === 'casual.state') {
        setRoom(response.room);
        if (response.room.status === 'battling') {
          router.replace(`/battle/${response.room.matchId}`);
        }
      }
    }).catch(err => {
      startRequested.current = false;
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [
    busy,
    client,
    clock,
    isPlayer,
    room,
    roomId,
    router,
  ]);

  useEffect(() => {
    if (!bothLocked || !isPlayer) return;
    const timer = window.setTimeout(() => {
      void client.request({ type: 'casual.start', roomId }).then(response => {
        if (response.type === 'casual.state') setRoom(response.room);
      }).catch(err => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [bothLocked, client, isPlayer, roomId]);

  useEffect(() => {
    if (!room?.matchId || !shouldEnterLiveBattle(room, playerId)) return;
    if (!cameFromSelect.current) {
      router.replace(`/battle/${room.matchId}`);
      return;
    }
    if (battleHandoff.current) return;
    battleHandoff.current = true;
    const matchId = room.matchId;
    window.setTimeout(() => {
      router.replace(`/battle/${matchId}`);
    }, CASUAL_BATTLE_HANDOFF_MS);
  }, [playerId, room, router]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const sendSelection = async (slots: number[], confirm = false) => {
    const response = await client.request({
      type: 'casual.select',
      roomId,
      slots,
      confirm,
    });
    if (response.type === 'casual.state') setRoom(response.room);
  };

  const toggleSlot = (slot: number) => {
    if (yours?.confirmed || busy) return;
    const next = selected.includes(slot)
      ? selected.filter(item => item !== slot)
      : selected.length < 3
        ? [...selected, slot]
        : selected;
    setSelected(next);
    void act(() => sendSelection(next));
  };

  const code = room ? room.id.slice(0, 8).toUpperCase() : '········';

  return (
    <div className={`pa-page${casualSelect && (countingDown || drafting || revealBattle) ? ' is-match-phase' : ''}`}>
      {casualSelect && (drafting || revealBattle) ? (
        <CasualSelectBoard
          yours={yours}
          selected={selected}
          confirmed={Boolean(yours?.confirmed) || revealBattle}
          rivalConfirmed={Boolean(rivalPreview?.confirmed)}
          secondsLeft={selectionLeft}
          disabled={busy || revealBattle}
          busy={busy}
          onToggle={toggleSlot}
          onLock={() => void act(() => sendSelection(selected, true))}
        />
      ) : null}
      {revealBattle ? <CasualBattleReveal yourId={yourId} rivalId={rivalId} /> : null}
      {casualSelect && (countingDown || drafting || revealBattle) ? (
        <ErrorToast error={error} onDismiss={() => setError(null)} />
      ) : null}
      {casualSelect && (countingDown || drafting || revealBattle) ? null : (
      <>
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1 className={room ? undefined : 'pa-async'}>{room ? `Challenge ${code}` : 'Finding your room…'}</h1>
          <p className="pa-lead">
            {competitive
              ? 'Bring a legal Gen 9 OU team. The rival cannot see your paste until the fight starts.'
              : 'Ready up once a rival joins. The 6→3 pick happens after both of you are ready.'}
          </p>
        </div>
        <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
      </header>

      <section className="pa-lobby">
        {room ? (
          <>
            <div className="pa-lobby-rail">
              <span className={`pa-live-pill status-${room.status}`}>
                <i /> {room.status}
              </span>
              <span className="pa-chip">{formatLabel(room)}</span>
              <span className="pa-chip">{room.battleSize.toUpperCase()}</span>
            </div>

            <p className="pa-lobby-note">
              {room ? lobbyNote({
                room,
                competitive,
                countingDown,
                countdownLeft,
                youReady,
                rivalReady,
              }) : ''}
            </p>

            {countingDown && !casualSelect ? (
              <div className="pa-countdown" role="status" aria-live="polite">
                <small>{countdownLeft > 0 ? 'Battle starts in' : 'Fight!'}</small>
                <b key={countdownLeft > 0 ? countdownLeft : 'go'}>{countdownLeft > 0 ? countdownLeft : 'GO'}</b>
              </div>
            ) : null}

            {competitive ? (
              <div className="pa-protocol">
                <span>
                  {savedTeam?.validated
                    ? savedTeam.name
                    : starterPaste
                      ? 'Demo Circuit'
                      : 'No legal team locked on this trainer'}
                </span>
                <TeamStrip species={savedTeam?.species} slots={6} />
                {!canLockCompetitive ? (
                  <Link className="pa-btn pa-btn-surface pa-btn-sm" href="/teams">Open My Teams</Link>
                ) : null}
              </div>
            ) : null}

            {room.battleSize === '2v2' ? (
              <div className="pa-protocol">
                <span>2v2 roster</span>
                <TeamStrip slots={3} />
              </div>
            ) : null}

            <div className="pa-lobby-vs">
              <article className={`pa-lobby-side cyan${yourId ? ' is-present' : ''}`}>
                <small>Your trainer</small>
                <ProfileTrainerSprite label={yourId} side="left" />
                <strong><TrainerName playerId={yourId} /></strong>
                <span className={`pa-lobby-ready ${youReady ? 'on' : ''}`}>
                  {sideReadyLabel({
                    isYou: true,
                    hasRival: Boolean(rivalId),
                    competitive,
                    drafting,
                    ready: youReady,
                    waitingForJoin: !room.opponentId,
                  })}
                </span>
              </article>
              <div className="pa-lobby-mid">
                <span>VS</span>
              </div>
              <article key={rivalId ?? 'open'} className={`pa-lobby-side coral${rivalId ? ' is-present' : ' is-open'}`}>
                <small>Opponent</small>
                {rivalId ? <ProfileTrainerSprite label={rivalId} side="right" /> : <span className="pa-fight-open" aria-hidden />}
                <strong>{rivalId ? <TrainerName playerId={rivalId} /> : 'Waiting…'}</strong>
                <span className={`pa-lobby-ready ${rivalReady ? 'on' : ''}`}>
                  {sideReadyLabel({
                    isYou: false,
                    hasRival: Boolean(rivalId),
                    competitive,
                    drafting,
                    ready: rivalReady,
                    waitingForJoin: !room.opponentId,
                  })}
                </span>
              </article>
            </div>
          </>
        ) : (
          <p className="pa-empty">Subscribing to room…</p>
        )}
      </section>

      {room ? (
        <section className="pa-split">
          <div className={`pa-vault${stakesLocked ? ' is-funded' : ''}${real ? ' rail-sol' : ' rail-poke'}`}>
            <header>
              <h2>{real ? 'Real stake' : 'Mock fight'}</h2>
              <span className={real ? (stakesLocked ? 'ok' : 'warn') : 'ok'}>
                {real ? (stakesLocked ? 'Escrow locked' : 'Escrow') : 'No SOL'}
              </span>
            </header>
            <div className="pa-econ-rows">
              <div><span>Your stake</span><strong>{money(room.economics.collateral)}</strong></div>
              <div><span>Opponent stake</span><strong>{money(room.economics.collateral)}</strong></div>
              <div><span>Amount locked</span><strong>{money(room.economics.totalPot)}</strong></div>
              <div className="fee"><span>Platform fee · 2%</span><strong>{money(room.economics.protocolFee)}</strong></div>
              <div className="payout"><span>Potential payout</span><strong>{money(room.economics.winnerPayout)}</strong></div>
            </div>
            <p className="pa-econ-note">
              {real
                ? (stakesLocked
                  ? 'Both stakes are locked. The server settles escrow from the battle result.'
                  : room.status === 'cancelled'
                    ? 'Challenge cancelled. Unlocked stakes are refunded by the escrow rules.'
                    : 'Funds lock only after each wallet signs. The battle cannot start until both deposits confirm.')
                : 'Mock fight. Development balance only. Nothing is escrowed on-chain.'}
            </p>
            {room.status === 'completed' ? (
              <div className="pa-econ-rows pa-settle">
                <div>
                  <span>{room.winnerId ? (room.winnerId === playerId ? 'WIN' : 'LOSS') : 'RESULT'}</span>
                  <strong>{room.winnerId ? (room.winnerId === playerId ? 'You won' : 'You lost') : 'Unresolved'}</strong>
                </div>
                <div><span>Stake</span><strong>{money(room.economics.collateral)}</strong></div>
                <div className="payout">
                  <span>Payout</span>
                  <strong>
                    {room.payout
                      ? money(room.payout.amount)
                      : 'Pending settlement'}
                  </strong>
                </div>
                <div><span>Escrow</span><strong>{real ? (room.payout ? 'Settled' : 'Pending') : 'Mock ledger'}</strong></div>
              </div>
            ) : null}
          </div>
          <div className="pa-split-side">
            <div className="pa-vault">
              <header>
                <h2>Room code</h2>
                <span className="ok">Bring your rival</span>
              </header>
              <div className="pa-room-code">
                <strong>{code}</strong>
                <span>{room.roomType === 'private' ? 'Private challenge' : 'Open challenge'}</span>
                <button
                  type="button"
                  className={`pa-btn pa-btn-surface pa-btn-sm${copied ? ' is-copied' : ''}`}
                  onClick={() => {
                    void navigator.clipboard?.writeText(window.location.href).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1200);
                    });
                  }}
                >
                  {copied ? 'Link copied' : 'Copy challenge link'}
                </button>
              </div>
            </div>
            {canAccept || (isPlayer && (
              (casualSelect && (room.status === 'full' || room.status === 'ready') && !countingDown)
              || (room.status !== 'battling' && room.status !== 'completed')
            )) ? (
              <div className="pa-vault">
                <div className="pa-lobby-actions pa-room-actions">
                  {canAccept && real && !acceptArmed ? (
                    <button
                      type="button"
                      className="pa-btn pa-btn-gold"
                      disabled={busy}
                      onClick={() => setAcceptArmed(true)}
                    >
                      Review stake
                    </button>
                  ) : null}
                  {canAccept && (!real || acceptArmed) ? (
                    <button
                      type="button"
                      className="pa-btn pa-btn-primary"
                      disabled={busy}
                      onClick={() => void act(async () => {
                        const response = await client.request({ type: 'casual.accept', roomId });
                        if (response.type === 'casual.state') setRoom(response.room);
                        await lockReturnedStake(response);
                      })}
                    >
                      {real ? 'Confirm stake and accept' : 'Accept challenge'}
                    </button>
                  ) : null}
                  {isPlayer && room.status !== 'battling' && room.status !== 'completed' ? (
                    <button
                      type="button"
                      className="pa-btn pa-btn-surface"
                      disabled={busy}
                      onClick={() => void act(async () => {
                        const response = await client.request({ type: 'casual.cancel', roomId });
                        if (response.type === 'casual.state') setRoom(response.room);
                      })}
                    >
                      Cancel
                    </button>
                  ) : null}
                  {isPlayer && casualSelect && (room.status === 'full' || room.status === 'ready') && !countingDown ? (
                    <button
                      type="button"
                      className="pa-btn pa-btn-primary"
                      disabled={busy || (real && !stakesLocked && !youReady)}
                      onClick={() => void act(async () => {
                        if (!playerId) return;
                        const response = await client.request({
                          type: 'casual.ready',
                          roomId,
                          ready: !youReady,
                        });
                        if (response.type === 'casual.state') setRoom(response.room);
                      })}
                    >
                      {youReady ? 'Unready' : 'Ready up'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <ErrorToast error={error} onDismiss={() => setError(null)} />

      <div className="pa-lobby-actions">
        {needsStake && !canAccept ? (
          <button
            type="button"
            className="pa-btn pa-btn-gold"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'casual.stake', roomId });
              await lockReturnedStake(response);
            })}
          >
            Lock my stake
          </button>
        ) : null}
        {isPlayer && competitive && room && (room.status === 'full' || room.status === 'ready') && !countingDown ? (
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={busy || (real && !stakesLocked && !youReady) || (!youReady && !canLockCompetitive)}
            onClick={() => void act(async () => {
              if (!playerId) return;
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !youReady,
                ...(!youReady && ownPaste ? { team: ownPaste } : {}),
              });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            {youReady ? 'Unready' : 'Lock team'}
          </button>
        ) : null}
        {isPlayer && room && room.battleSize === '2v2' && (room.status === 'full' || room.status === 'ready') ? (
          <button
            type="button"
            className="pa-btn pa-btn-surface"
            disabled={busy || (real && !stakesLocked && !(playerId && room.ready[playerId]))}
            onClick={() => void act(async () => {
              if (!playerId) return;
              const response = await client.request({
                type: 'casual.ready',
                roomId,
                ready: !room.ready[playerId],
              });
              if (response.type === 'casual.state') setRoom(response.room);
            })}
          >
            {playerId && room.ready[playerId] ? 'Unready' : 'Ready up'}
          </button>
        ) : null}
        {room?.battleSize === '2v2' ? (
          <span className="pa-soon" style={{ border: 0, padding: 0 }}>2v2 Multi · Coming soon</span>
        ) : null}
        {room?.status === 'battling' ? (
          <Link className="pa-btn pa-btn-primary" href={`/battle/${room.matchId}`}>Rejoin fight</Link>
        ) : null}
        {isPlayer && room?.status === 'battling' ? (
          <button
            type="button"
            className="pa-btn pa-btn-danger"
            disabled={busy}
            onClick={() => void act(async () => {
              const response = await client.request({ type: 'casual.forfeit', roomId });
              if (response.type === 'casual.state') {
                setRoom(response.room);
                router.push(`/result/${response.room.id}`);
              }
            })}
          >
            Forfeit fight
          </button>
        ) : null}
        {room?.status === 'completed' ? (
          <Link className="pa-btn pa-btn-primary" href={`/result/${room.id}`}>View result</Link>
        ) : null}
      </div>
      </>
      )}
    </div>
  );
}
