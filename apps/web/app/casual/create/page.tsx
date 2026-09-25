'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { PageHeader, Panel } from '@/components/shell';
import { EconomyBreakdown } from '@/components/ui';
import { useArena } from '@/lib/arena-context';
import type { CasualEconomicsPreview, DemoPlayerId } from '@/lib/protocol';

export default function CreateCasualPage() {
  const { client, playerId, snapshot } = useArena();
  const router = useRouter();
  const [roomType, setRoomType] = useState<'private' | 'open'>('open');
  const [battleSize, setBattleSize] = useState<'1v1' | '2v2'>('1v1');
  const [collateral, setCollateral] = useState(100_000);
  const [invitedPlayerId, setInvitedPlayerId] = useState<DemoPlayerId>(
    playerId === 'demo-player-1' ? 'demo-player-2' : 'demo-player-1',
  );
  const [preview, setPreview] = useState<CasualEconomicsPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.request({ type: 'casual.preview', collateral }).then(response => {
      if (!cancelled && response.type === 'casual.preview') setPreview(response.economics);
    }).catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [client, collateral]);

  const overBalance = Boolean(snapshot && collateral > snapshot.wallet.balance);

  const onCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await client.request({
        type: 'casual.create',
        roomType,
        battleSize,
        collateral,
        ...(roomType === 'private' ? { invitedPlayerId } : {}),
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
        eyebrow="Casual // prepare for battle"
        title="Set the stakes."
        description="Choose your format, call a rival, and put your trainer on the board."
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
              <button type="button" className="selected" onClick={() => setBattleSize('1v1')}>1v1 Singles</button>
              <button type="button" disabled title="Coming soon">2v2 Multi <small>Soon</small></button>
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
            <label htmlFor="collateral">Collateral (POKE)</label>
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
              <label htmlFor="invite">Invite opponent</label>
              <select
                id="invite"
                value={invitedPlayerId}
                onChange={event => setInvitedPlayerId(event.target.value as DemoPlayerId)}
              >
                <option value="demo-player-1">demo-player-1</option>
                <option value="demo-player-2">demo-player-2</option>
              </select>
            </div>
          ) : null}
        </div>
        {roomType === 'private' ? <p className="form-note">Private callout is sent to the selected development trainer.</p> : <p className="form-note">Open challenges are visible to every trainer in the queue.</p>}
      </Panel>
      <Panel eyebrow="Match economics" title="If you win, you take the pot">
        <div className="stack">
          <EconomyBreakdown economics={preview} />
          {overBalance ? <div className="error-banner">Collateral exceeds your development balance.</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || overBalance || collateral <= 0}
            onClick={() => void onCreate()}
          >
            {busy ? 'Calling trainer…' : 'Create challenge'}
          </button>
        </div>
      </Panel>
    </div>
  );
}
