'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
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
  const [collateral, setCollateral] = useState(chain ? 500_000_000 : 100_000);
  const [invitedPlayerId, setInvitedPlayerId] = useState('');
  const [preview, setPreview] = useState<CasualEconomicsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!walletConnected) return;
    let cancelled = false;
    void client.request({ type: 'casual.preview', collateral }).then(response => {
      if (!cancelled && response.type === 'casual.preview') setPreview(response.economics);
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [client, collateral, walletConnected]);

  const overBalance = Boolean(snapshot && collateral > snapshot.wallet.balance);
  const formatLabel = ruleset === 'competitive' ? 'Competitive · Gen 9 OU' : 'Casual 6 → 3';
  const setupNote = battleSize === '2v2'
    ? '2v2 rooms can be configured, but battle start is not available yet.'
    : ruleset === 'competitive'
      ? 'Lock a legal Gen 9 OU six from My Teams after both trainers join.'
      : roomType === 'private'
        ? 'Private callout is limited to the invited wallet. Random sixes stay sealed until both trainers ready and the countdown ends.'
        : 'Open challenges are visible in the queue. Random sixes stay sealed until both trainers ready and the countdown ends.';

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
        ...(chain ? { collateralLamports: collateral } : {}),
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
          <p className="pa-kicker"><i /> — {chain ? 'Casual // SOL wager' : 'Casual // player-funded fight'} —</p>
          <h1>Set the stakes.</h1>
          <p className="pa-lead">
            {chain
              ? 'Hold at least $20 of POKE to play. Each side posts the same SOL collateral; a 2% fee comes off the pool at match start.'
              : 'Create a player-funded room. Every participant posts the same collateral before the fight starts. Casual uses assigned sets. Competitive uses your own team.'}
          </p>
        </div>
        <Link className="pa-btn pa-btn-surface" href="/arena">Back to arena</Link>
      </header>

      <div className="pa-live-strip">
        <span className="pa-live-pill"><i /> {walletConnected ? 'Ready to post' : 'Wallet needed'}</span>
        <strong>{formatLabel}</strong>
        <span>{battleSize.toUpperCase()}</span>
        <span>{roomType === 'private' ? 'Private callout' : 'Open queue'}</span>
        <span style={{ marginLeft: 'auto', color: '#8ea0c0' }}>No withdrawal tax</span>
      </div>

      <section className="pa-split">
        <div className="pa-vault">
          <header>
            <h2>Prepare your fight</h2>
            <span className="ok">Match setup</span>
          </header>

          <div className="pa-setup">
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
                {chain ? 'Collateral each (lamports)' : 'Collateral each (POKE)'}
              </label>
              <input
                id="collateral"
                type="number"
                min={1}
                value={collateral}
                onChange={event => setCollateral(Number(event.target.value))}
              />
              {chain ? (
                <p className="pa-econ-note">
                  {(collateral / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 })} SOL each
                  {snapshot?.passport && !snapshot.passport.eligible
                    ? ' · Passport below $20 — connect a wallet that holds enough POKE.'
                    : ''}
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
            <h2>Match economics</h2>
            <span className="ok">Player-funded</span>
          </header>
          <div className="pa-econ-rows">
            <div>
              <span>Collateral each</span>
              <strong>{preview ? formatPoke(preview.collateral) : '—'}</strong>
            </div>
            <div>
              <span>Gross match pool</span>
              <strong>{preview ? formatPoke(preview.totalPot) : '—'}</strong>
            </div>
            <div className="fee">
              <span>Protocol fee · 2% at match start</span>
              <strong>{preview ? formatPoke(preview.protocolFee) : '—'}</strong>
            </div>
            <div className="payout">
              <span>Winner receives</span>
              <strong>{preview ? formatPoke(preview.winnerPayout) : '—'}</strong>
            </div>
          </div>
          <p className="pa-econ-note">
            {preview
              ? 'Player-funded. One fee from the gross pool. No withdrawal tax.'
              : 'Enter collateral to preview the player-funded pool.'}
          </p>
          {!walletConnected ? <p className="pa-setup-warn">Connect a wallet to create a challenge.</p> : null}
          {overBalance && !chain ? <p className="pa-setup-warn">Collateral exceeds your development balance.</p> : null}
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
                disabled={busy || overBalance || collateral <= 0 || (roomType === 'private' && !invitedPlayerId.trim())}
                onClick={() => void onCreate()}
              >
                {busy ? 'Calling trainer…' : 'Create challenge'}
              </button>
            )}
          </div>
        </div>
      </section>
      <ErrorToast error={error} onDismiss={() => setError(null)} />
    </div>
  );
}
