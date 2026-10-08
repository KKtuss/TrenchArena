'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorToast } from '@/components/error-toast';
import { previewSolCasual } from '@pokearena/solana-client';

import { useArena } from '@/lib/arena-context';
import { formatSolLamports } from '@/lib/api-client';
import type { CasualRuleset } from '@/lib/protocol';

function solInputToLamports(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sol = Number(trimmed);
  if (!Number.isFinite(sol) || sol <= 0) return null;
  const lamports = Math.round(sol * 1e9);
  if (!Number.isSafeInteger(lamports) || lamports <= 0) return null;
  return lamports;
}

function safePreviewSolCasual(collateralLamports: number) {
  try {
    return previewSolCasual(collateralLamports);
  } catch {
    return null;
  }
}

export default function CreateCasualPage() {
  const {
    client,
    snapshot,
    walletConnected,
    walletAdapter,
    connectInjectedWallet,
    connectingWallet,
    chainEconomyEnabled,
  } = useArena();
  const router = useRouter();
  const [roomType, setRoomType] = useState<'private' | 'open'>('private');
  const [battleSize, setBattleSize] = useState<'1v1' | '2v2'>('1v1');
  const [ruleset, setRuleset] = useState<CasualRuleset>('casual');
  const [collateralInput, setCollateralInput] = useState('0.01');
  const [confirmedStake, setConfirmedStake] = useState(false);
  const [invitedPlayerId, setInvitedPlayerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const collateral = solInputToLamports(collateralInput);
  const preview = collateral !== null ? safePreviewSolCasual(collateral) : null;
  const shown = preview
    ? {
        collateral: preview.collateralLamports,
        totalPot: preview.totalPotLamports,
        protocolFee: preview.protocolFeeLamports,
        winnerPayout: preview.winnerPayoutLamports,
      }
    : null;
  const freeLamports = snapshot?.solBalances?.freeLamports;
  const overBalance = Boolean(
    collateral !== null
    && freeLamports
    && BigInt(collateral) + 10_000n > BigInt(freeLamports),
  );
  const formatLabel = ruleset === 'competitive' ? 'Competitive · Gen 9 OU' : 'Casual 6 → 3';
  const setupNote = battleSize === '2v2'
    ? '2v2 rooms can be configured, but battle start is not available yet.'
    : ruleset === 'competitive'
      ? 'Lock a legal Gen 9 OU six from My Teams after both trainers join.'
      : roomType === 'private'
        ? 'Private callout is limited to the invited wallet. One shared six stays sealed until both trainers ready and the countdown ends.'
        : 'Open challenges are visible in the queue. One shared six stays sealed until both trainers ready and the countdown ends.';

  const onCreate = async () => {
    if (!chainEconomyEnabled) {
      setError('Chain economy is required to create a challenge.');
      return;
    }
    if (!walletConnected) {
      setError('Connect a wallet before creating a challenge.');
      return;
    }
    if (collateral === null || !preview) {
      setError('Enter a valid SOL stake greater than zero.');
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
        stake: 'real',
        collateralLamports: collateral,
        ...(roomType === 'private' && invitedPlayerId.trim()
          ? { invitedPlayerId: invitedPlayerId.trim() }
          : {}),
      });
      if (response.type === 'casual.created') {
        if (response.intent?.serializedTx?.length && walletAdapter) {
          const { signSerializedTransaction } = await import('@/lib/solana-tx');
          const signed = await signSerializedTransaction(
            walletAdapter,
            response.intent.serializedTx,
          );
          const confirmation = await client.request({
            type: 'tx.confirm',
            intentId: response.intent.intentId,
            signature: signed.signature,
            signedTransaction: signed.signedTransaction,
          });
          if (confirmation.type !== 'tx.update') {
            throw new Error('The server rejected the wager transaction. The challenge was not opened.');
          }
          if (confirmation.status === 'failed' || confirmation.status === 'expired' || confirmation.status === 'cancelled') {
            throw new Error(confirmation.error ?? 'The wager transaction did not land. The challenge was not opened.');
          }
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
          <h1>Create a real-stake challenge.</h1>
          <p className="pa-lead">
            Your SOL stake is locked first. Once it confirms, the challenge becomes visible to the invited or queued opponent. A 2% fee comes off the pool at match start.
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
              <label>Format</label>
              <div className="pa-format-choice">
                <button
                  type="button"
                  className={ruleset === 'casual' ? 'selected' : ''}
                  aria-pressed={ruleset === 'casual'}
                  onClick={() => setRuleset('casual')}
                >
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
              <label htmlFor="collateral">Stake each (SOL)</label>
              <input
                id="collateral"
                type="number"
                min={0.001}
                step={0.001}
                value={collateralInput}
                onChange={event => {
                  setCollateralInput(event.target.value);
                  setConfirmedStake(false);
                }}
              />
              <p className="pa-econ-note">
                {collateral !== null ? `${formatSolLamports(collateral)} each` : 'Enter a stake amount'}
                {freeLamports !== undefined ? ` · wallet ${formatSolLamports(freeLamports)}` : ''}
              </p>
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
          {!chainEconomyEnabled ? (
            <p className="pa-setup-warn">Chain economy is required. Challenges cannot be created without it.</p>
          ) : null}
        </div>

        <div className="pa-vault pa-stake-panel">
          <header>
            <h2>Stake terms</h2>
            <span className="warn">Escrow</span>
          </header>
          <div className="pa-econ-rows">
            <div>
              <span>Your stake</span>
              <strong>{shown ? formatSolLamports(shown.collateral) : '—'}</strong>
            </div>
            <div>
              <span>Opponent stake</span>
              <strong>{shown ? formatSolLamports(shown.collateral) : '—'}</strong>
            </div>
            <div>
              <span>Amount locked</span>
              <strong>{shown ? formatSolLamports(shown.totalPot) : '—'}</strong>
            </div>
            <div className="fee">
              <span>Platform fee · 2% at match start</span>
              <strong>{shown ? formatSolLamports(shown.protocolFee) : '—'}</strong>
            </div>
            <div className="payout">
              <span>Potential payout</span>
              <strong>{shown ? formatSolLamports(shown.winnerPayout) : '—'}</strong>
            </div>
          </div>
          <p className="pa-econ-note">
            Loser receives nothing from the pool. Funds stay locked until the server settles the battle result.
          </p>

          <div className="pa-stake-footer">
            <label className="pa-stake-confirm">
              <input
                type="checkbox"
                checked={confirmedStake}
                onChange={event => setConfirmedStake(event.target.checked)}
              />
              <span>
                I confirm this {collateral !== null ? formatSolLamports(collateral) : '—'} wager. The creator signs after the room is created; the opponent signs after joining.
              </span>
            </label>
            {!walletConnected ? <p className="pa-setup-warn">Connect a wallet to create a challenge.</p> : null}
            {overBalance ? <p className="pa-setup-warn">Insufficient SOL for this stake.</p> : null}
            {snapshot?.passport && !snapshot.passport.eligible ? (
              <p className="pa-setup-warn">Passport is below the play threshold. Real stake will be rejected.</p>
            ) : null}
            {!walletConnected ? (
              <button
                type="button"
                className="pa-btn pa-btn-primary pa-stake-submit"
                disabled={connectingWallet}
                onClick={() => void connectInjectedWallet()}
              >
                {connectingWallet ? 'Connecting…' : 'Connect wallet'}
              </button>
            ) : (
              <button
                type="button"
                className="pa-btn pa-btn-primary pa-stake-submit"
                disabled={
                  busy
                  || !chainEconomyEnabled
                  || overBalance
                  || collateral === null
                  || !preview
                  || !confirmedStake
                  || (roomType === 'private' && !invitedPlayerId.trim())
                }
                onClick={() => void onCreate()}
              >
                {busy ? 'Creating challenge…' : 'Create challenge'}
              </button>
            )}
          </div>
        </div>
      </section>
      <ErrorToast error={error} onDismiss={() => setError(null)} />
    </div>
  );
}
