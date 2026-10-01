'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { useArena } from '@/lib/arena-context';
import { formatPoke, formatSolLamports } from '@/lib/api-client';
import type { CasualEconomicsPreview, CasualRuleset } from '@/lib/protocol';

export default function CreateCasualPage() {
  const {
    client,
    snapshot,
    walletConnected,
    walletAdapter,
    connectInjectedWallet,
    connectingWallet,
  } = useArena();
  const router = useRouter();
  const [roomType, setRoomType] = useState<'private' | 'open'>('open');
  const [battleSize, setBattleSize] = useState<'1v1' | '2v2'>('1v1');
  const [ruleset, setRuleset] = useState<CasualRuleset>('casual');
  const chain = Boolean(snapshot?.chainEconomyEnabled);
  const [stakeChoice, setStakeChoice] = useState<'mock' | 'real' | null>(null);
  const stake = stakeChoice ?? (chain ? 'real' : 'mock');
  const real = stake === 'real';
  const [collateral, setCollateral] = useState(100_000);
  const [confirmedStake, setConfirmedStake] = useState(false);
  const [invitedPlayerId, setInvitedPlayerId] = useState('');
  const [preview, setPreview] = useState<CasualEconomicsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chain || stakeChoice !== null) return;
    setCollateral(50_000_000);
    setRoomType('private');
  }, [chain, stakeChoice]);

  useEffect(() => {
    if (!walletConnected || real) return;
    let cancelled = false;
    void client.request({ type: 'casual.preview', collateral, stake: 'mock' }).then(response => {
      if (!cancelled && response.type === 'casual.preview' && 'collateral' in response.economics) {
        setPreview(response.economics);
      }
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [client, collateral, walletConnected, real]);

  const realFee = Math.floor((collateral * 2 * 200) / 10_000);
  const shown = real
    ? {
        collateral,
        totalPot: collateral * 2,
        protocolFee: realFee,
        winnerPayout: collateral * 2 - realFee,
      }
    : preview;
  const freeLamports = snapshot?.solBalances?.freeLamports;
  const overBalance = real
    ? Boolean(freeLamports && BigInt(Math.max(0, collateral)) + 10_000n > BigInt(freeLamports))
    : Boolean(snapshot && collateral > snapshot.wallet.balance);
  const formatLabel = ruleset === 'competitive' ? 'Competitive · Gen 9 OU' : 'Casual 6 → 3';
  const setupNote = battleSize === '2v2'
    ? '2v2 rooms can be configured, but battle start is not available yet.'
    : ruleset === 'competitive'
      ? 'Lock a legal Gen 9 OU six from My Teams after both trainers join.'
      : roomType === 'private'
        ? 'Private callout is limited to the invited wallet. One shared six stays sealed until both trainers ready and the countdown ends.'
        : 'Open challenges are visible in the queue. One shared six stays sealed until both trainers ready and the countdown ends.';

  const onCreate = async () => {
    if (!walletConnected) {
      setError('Connect a wallet before creating a challenge.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await client.request({
        type: 'casual.create',
        roomType,
        battleSize,
        ruleset,
        collateral,
        stake,
        ...(real ? { collateralLamports: collateral } : {}),
        ...(roomType === 'private' && invitedPlayerId.trim()
          ? { invitedPlayerId: invitedPlayerId.trim() }
          : {}),
      });
      if (response.type === 'casual.created') {
        if (response.intent?.serializedTx?.length && walletAdapter) {
          const { sendSerializedTransaction } = await import('@/lib/solana-tx');
          const signature = await sendSerializedTransaction(
            walletAdapter,
            response.intent.serializedTx,
          );
          await client.request({
            type: 'tx.confirm',
            intentId: response.intent.intentId,
            signature,
          });
        }
        router.push(`/casual/${response.room.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pa-page">
      <header className="pa-page-head pa-page-head-row">
        <div>
          <h1>{real ? 'Lock a real stake.' : 'Set a mock fight.'}</h1>
          <p className="pa-lead">
            {real
              ? 'Both trainers post the same SOL stake into escrow. A 2% fee comes off the pool at match start. The battle winner is paid from that escrow.'
              : 'Mock fights use the development POKE ledger. No SOL moves. This is the default path.'}
          </p>
        </div>
        <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
      </header>

      <div className="pa-live-strip">
        <span className="pa-live-pill"><i /> {walletConnected ? 'Ready to post' : 'Wallet needed'}</span>
        <strong>{formatLabel}</strong>
        <span>{battleSize.toUpperCase()}</span>
        <span>{roomType === 'private' ? 'Private callout' : 'Open queue'}</span>
        <span className="pa-strip-end">No withdrawal tax</span>
      </div>

      <section className="pa-split">
        <div className="pa-vault">
          <header>
            <h2>Prepare your fight</h2>
            <span className="ok">Match setup</span>
          </header>

          <div className="pa-setup">
            <div className="pa-field pa-field-wide">
              <label>Fight type</label>
              <div className="pa-segmented">
                <button
                  type="button"
                  className={stake === 'mock' ? 'selected' : ''}
                  onClick={() => {
                    setStakeChoice('mock');
                    setConfirmedStake(false);
                    setCollateral(100_000);
                  }}
                >
                  Mock fight
                </button>
                <button
                  type="button"
                  className={stake === 'real' ? 'selected' : ''}
                  disabled={!chain}
                  title={chain ? 'Lock SOL in the existing escrow' : 'Chain economy is not enabled'}
                  onClick={() => {
                    setStakeChoice('real');
                    setConfirmedStake(false);
                    setRoomType('private');
                    setCollateral(50_000_000);
                  }}
                >
                  Real stake
                </button>
              </div>
              {!chain ? <p className="pa-econ-note">Real stake needs chain economy. Mock fight stays available.</p> : null}
            </div>

            <div className="pa-field pa-field-wide">
              <label>Format</label>
              <div className="pa-format-choice">
                <button
                  type="button"
                  className={ruleset === 'casual' ? 'selected' : ''}
                  aria-pressed={ruleset === 'casual'}
                  onClick={() => setRuleset('casual')}
                >
                  <span className="format-icon">C</span>
                  <span>
                    <strong>Casual</strong>
                    <small>Assigned curated six · pick three · no team building</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={ruleset === 'competitive' ? 'selected' : ''}
                  aria-pressed={ruleset === 'competitive'}
                  onClick={() => setRuleset('competitive')}
                >
                  <span className="format-icon">OU</span>
                  <span>
                    <strong>Competitive</strong>
                    <small>Bring your own Gen 9 OU team from My Teams</small>
                  </span>
                </button>
              </div>
            </div>

            <div className="pa-field">
              <label>Battle size</label>
              <div className="pa-segmented">
                <button type="button" className={battleSize === '1v1' ? 'selected' : ''} onClick={() => setBattleSize('1v1')}>
                  1v1 Singles
                </button>
                <button
                  type="button"
                  className={battleSize === '2v2' ? 'selected' : ''}
                  onClick={() => setBattleSize('2v2')}
                  title="Rooms can be configured; starts are not supported yet"
                >
                  2v2 Multi <small>Soon</small>
                </button>
              </div>
            </div>

            <div className="pa-field">
              <label>Room type</label>
              <div className="pa-segmented">
                <button type="button" className={roomType === 'open' ? 'selected' : ''} onClick={() => setRoomType('open')}>
                  Open queue
                </button>
                <button type="button" className={roomType === 'private' ? 'selected' : ''} onClick={() => setRoomType('private')}>
                  Private callout
                </button>
              </div>
            </div>

            <div className="pa-field pa-field-wide">
              <label htmlFor="collateral">
                {real ? 'Stake each (SOL)' : 'Collateral each (POKE)'}
              </label>
              {real ? (
                <input
                  id="collateral"
                  type="number"
                  min={0.001}
                  step={0.001}
                  value={collateral / 1e9}
                  onChange={event => {
                    const next = Math.round(Number(event.target.value) * 1e9);
                    setCollateral(Number.isFinite(next) ? next : 0);
                    setConfirmedStake(false);
                  }}
                />
              ) : (
                <input
                  id="collateral"
                  type="number"
                  min={1}
                  value={collateral}
                  onChange={event => setCollateral(Number(event.target.value))}
                />
              )}
              {real ? (
                <p className="pa-econ-note">
                  {formatSolLamports(collateral)} each
                  {freeLamports !== undefined ? ` · wallet ${formatSolLamports(freeLamports)}` : ''}
                </p>
              ) : null}
            </div>

            {roomType === 'private' ? (
              <div className="pa-field pa-field-wide">
                <label htmlFor="invite">Invite opponent wallet</label>
                <input
                  id="invite"
                  value={invitedPlayerId}
                  onChange={event => setInvitedPlayerId(event.target.value)}
                  placeholder="Solana wallet address"
                />
              </div>
            ) : null}
          </div>
          <p className="pa-econ-note">{setupNote}</p>
        </div>

        <div className="pa-vault">
            <header>
              <h2>{real ? 'Stake terms' : 'Match economics'}</h2>
              <span className={real ? 'warn' : 'ok'}>{real ? 'Escrow' : 'Mock ledger'}</span>
            </header>
            <div className="pa-econ-rows">
              <div>
                <span>{real ? 'Your stake' : 'Collateral each'}</span>
                <strong>{shown ? (real ? formatSolLamports(shown.collateral) : formatPoke(shown.collateral)) : '—'}</strong>
              </div>
              <div>
                <span>Opponent stake</span>
                <strong>{shown ? (real ? formatSolLamports(shown.collateral) : formatPoke(shown.collateral)) : '—'}</strong>
              </div>
              <div>
                <span>{real ? 'Amount locked' : 'Gross match pool'}</span>
                <strong>{shown ? (real ? formatSolLamports(shown.totalPot) : formatPoke(shown.totalPot)) : '—'}</strong>
              </div>
              <div className="fee">
                <span>Platform fee · 2% at match start</span>
                <strong>{shown ? (real ? formatSolLamports(shown.protocolFee) : formatPoke(shown.protocolFee)) : '—'}</strong>
              </div>
              <div className="payout">
                <span>Potential payout</span>
                <strong>{shown ? (real ? formatSolLamports(shown.winnerPayout) : formatPoke(shown.winnerPayout)) : '—'}</strong>
              </div>
            </div>
            <p className="pa-econ-note">
              {real
                ? 'Loser receives nothing from the pool. Funds stay locked until the server settles the battle result.'
                : 'Mock fight. Development POKE only. No SOL moves.'}
            </p>
            {real ? (
              <label className="pa-econ-note" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={confirmedStake}
                  onChange={event => setConfirmedStake(event.target.checked)}
                />
                <span>I confirm this stake. Both wallets will lock the same amount in escrow.</span>
              </label>
            ) : null}
            {!walletConnected ? <p className="pa-setup-warn">Connect a wallet to create a challenge.</p> : null}
            {overBalance ? (
              <p className="pa-setup-warn">
                {real ? 'Insufficient SOL for this stake.' : 'Collateral exceeds your development balance.'}
              </p>
            ) : null}
            {real && snapshot?.passport && !snapshot.passport.eligible ? (
              <p className="pa-setup-warn">Passport is below the play threshold. Real stake will be rejected.</p>
            ) : null}
            <div className="pa-lobby-actions" style={{ marginTop: '1rem' }}>
              {!walletConnected ? (
                <button
                  type="button"
                  className="pa-btn pa-btn-primary"
                  disabled={connectingWallet}
                  onClick={() => void connectInjectedWallet()}
                >
                  {connectingWallet ? 'Connecting…' : 'Connect wallet'}
                </button>
              ) : (
                <button
                  type="button"
                  className="pa-btn pa-btn-primary"
                  disabled={busy || overBalance || collateral <= 0 || (roomType === 'private' && !invitedPlayerId.trim()) || (real && !confirmedStake)}
                  onClick={() => void onCreate()}
                >
                  {busy ? 'Locking challenge…' : real ? 'Confirm and challenge' : 'Create mock fight'}
                </button>
              )}
            </div>
        </div>
      </section>
      <ErrorToast error={error} onDismiss={() => setError(null)} />
    </div>
  );
}
