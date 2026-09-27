'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorToast } from '@/components/error-toast';

import { PageHeader, Panel } from '@/components/shell';
import { CasualPoolEquation, EconomyBreakdown } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import type { CasualEconomicsPreview } from '@/lib/protocol';

export default function CreateCasualPage() {
  const { client, snapshot, walletConnected, connectInjectedWallet, connectingWallet } = useArena();
  const router = useRouter();
  const [roomType, setRoomType] = useState<'private' | 'open'>('open');
  const [battleSize, setBattleSize] = useState<'1v1' | '2v2'>('1v1');
  const [collateral, setCollateral] = useState(100_000);
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
        collateral,
        ...(roomType === 'private' && invitedPlayerId.trim()
          ? { invitedPlayerId: invitedPlayerId.trim() }
          : {}),
      });
      if (response.type === 'casual.created') {
        router.push(`/casual/${response.room.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageHeader
        eyebrow="Casual // player-funded fight"
        title="Set the stakes."
        description="Create a player-funded room. Every participant posts the same collateral before the fight starts."
      />
      <Panel eyebrow="Match setup" title="Prepare your fight" strong>
        <div className="setup-grid">
          <div className="field field-wide">
            <label>Format</label>
            <div className="format-lockup"><span className="format-icon">1v1</span><span><strong>Gen 9 Singles</strong><small>Official ruleset · BattleEngine verified</small></span></div>
          </div>
          <div className="field">
            <label>Battle size</label>
            <div className="segmented-control">
              <button type="button" className={battleSize === '1v1' ? 'selected' : ''} onClick={() => setBattleSize('1v1')}>1v1 Singles</button>
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
          <div className="field">
            <label htmlFor="roomType">Room type</label>
            <div className="segmented-control">
              <button type="button" className={roomType === 'open' ? 'selected' : ''} onClick={() => setRoomType('open')}>Open queue</button>
              <button type="button" className={roomType === 'private' ? 'selected' : ''} onClick={() => setRoomType('private')}>Private callout</button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="collateral">Collateral each (POKE)</label>
            <input
              id="collateral"
              type="number"
              min={1}
              value={collateral}
              onChange={event => setCollateral(Number(event.target.value))}
            />
          </div>
          {roomType === 'private' ? (
            <div className="field">
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
        {battleSize === '2v2' ? (
          <p className="form-note">2v2 rooms can be configured, but battle start is not available yet.</p>
        ) : roomType === 'private' ? (
          <p className="form-note">Private callout is limited to the invited wallet address.</p>
        ) : (
          <p className="form-note">Open challenges are visible to every trainer in the queue.</p>
        )}
      </Panel>
      <Panel eyebrow="Match economics" title="Gross pool → one fee → winner payout">
        <div className="stack">
          <CasualPoolEquation economics={preview} />
          <EconomyBreakdown economics={preview} />
          {!walletConnected ? <div className="error-banner">Connect a wallet to create a challenge.</div> : null}
          {overBalance ? <div className="error-banner">Collateral exceeds your development balance.</div> : null}
          <ErrorToast error={error} onDismiss={() => setError(null)} />
          {!walletConnected ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={connectingWallet}
              onClick={() => void connectInjectedWallet()}
            >
              {connectingWallet ? 'Connecting…' : 'Connect wallet'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || overBalance || collateral <= 0 || (roomType === 'private' && !invitedPlayerId.trim())}
              onClick={() => void onCreate()}
            >
              {busy ? 'Calling trainer…' : 'Create challenge'}
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}
