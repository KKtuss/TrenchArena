'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { useArena } from '@/lib/arena-context';
import { isDemoAuthEnabled } from '@/lib/demo-auth';
import {
  isTrainerUsername,
  searchTrainerSprites,
  trainerSpriteSrc,
  type TrainerSpriteEntry,
} from '@/lib/trainer-profile';

export function TrainerProfileControl() {
  const {
    walletConnected,
    availableWallets,
    connectingWallet,
    connectInjectedWallet,
    connectPreviewSession,
    disconnectInjectedWallet,
    trainerSpriteId,
    trainerUsername,
    needsProfileSetup,
    saveTrainerProfile,
    playerLabel,
    authBusy,
  } = useArena();
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [mounted, setMounted] = useState(false);
  const showEditor = needsProfileSetup || editing;
  const avatar = (
    <>
      <img
        className="trainer-avatar"
        src={trainerSpriteSrc(walletConnected ? trainerSpriteId : 'unknown')}
        alt=""
        width={40}
        height={40}
      />
      <span className="trainer-control-copy">
        <small>{walletConnected ? 'Trainer' : 'Wallet'}</small>
        <strong>{walletConnected ? playerLabel : 'Connect'}</strong>
      </span>
    </>
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="trainer-profile">
      {walletConnected ? (
        <Link
          href="/profile"
          className={`trainer-control${pathname.startsWith('/profile') ? ' is-active' : ''}`}
          aria-current={pathname.startsWith('/profile') ? 'page' : undefined}
        >
          {avatar}
        </Link>
      ) : (
        <button
          type="button"
          className="trainer-control"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(current => !current)}
        >
          {avatar}
        </button>
      )}
      {open && !walletConnected && !showEditor && mounted ? createPortal(
        <div className="trainer-popover trainer-popover-fixed" role="dialog" aria-label="Connect wallet">
          <div className="trainer-popover-head">
            <small>Wallet</small>
            <strong>Connect</strong>
            <p>Phantom, Backpack, or another Solana wallet.</p>
          </div>
          <div className="trainer-wallet-actions">
              {(availableWallets.length ? availableWallets : [{ id: 'any', name: 'Solana wallet', adapter: null as any }]).map(wallet => (
                <button
                  key={wallet.id}
                  type="button"
                  className="pa-btn pa-btn-primary"
                  disabled={connectingWallet || authBusy}
                  onClick={() => void connectInjectedWallet(wallet.adapter ? wallet : undefined)}
                >
                  {connectingWallet ? 'Connecting…' : `Connect ${wallet.name}`}
                </button>
              ))}
              {isDemoAuthEnabled() ? (
                <>
                  <button
                    type="button"
                    className="pa-btn pa-btn-surface"
                    disabled={connectingWallet || authBusy}
                    onClick={() => void connectPreviewSession('demo-player-1')}
                  >
                    Continue as Player 1
                  </button>
                  <button
                    type="button"
                    className="pa-btn pa-btn-surface"
                    disabled={connectingWallet || authBusy}
                    onClick={() => void connectPreviewSession('demo-player-2')}
                  >
                    Continue as Player 2
                  </button>
                </>
              ) : null}
          </div>
        </div>,
        document.body,
      ) : null}
      {showEditor ? (
        <TrainerSetup
          required={needsProfileSetup}
          initialUsername={trainerUsername ?? ''}
          initialSpriteId={trainerSpriteId}
          busy={authBusy}
          onSave={(username, spriteId) => {
            saveTrainerProfile(username, spriteId);
            setEditing(false);
            setOpen(false);
          }}
          onCancel={() => setEditing(false)}
          onDisconnect={() => {
            void disconnectInjectedWallet().then(() => {
              setEditing(false);
              setOpen(false);
            });
          }}
        />
      ) : null}
    </div>
  );
}

export function TrainerSetup({
  required,
  initialUsername,
  initialSpriteId,
  busy,
  onSave,
  onCancel,
  onDisconnect,
}: {
  required: boolean;
  initialUsername: string;
  initialSpriteId: string;
  busy: boolean;
  onSave: (username: string, spriteId: string) => void;
  onCancel: () => void;
  onDisconnect: () => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [spriteId, setSpriteId] = useState(initialSpriteId);
  const [mounted, setMounted] = useState(false);
  const nameOk = isTrainerUsername(username);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div className="trainer-setup" role="presentation">
      <div className="trainer-setup-card" role="dialog" aria-modal="true" aria-label={required ? 'Create trainer' : 'Edit profile'}>
        <header className="trainer-popover-head">
          <div>
            <strong>{required ? 'Create your trainer' : 'Edit profile'}</strong>
            <p>
              {required
                ? 'Choose a username and a trainer sprite. You can change them later with Edit profile.'
                : 'Update your username or trainer sprite.'}
            </p>
          </div>
        </header>
        <label className="trainer-picker-search">
          <span>Username</span>
          <input
            value={username}
            maxLength={16}
            autoFocus
            placeholder="2–16 characters"
            aria-label="Trainer username"
            onChange={event => setUsername(event.target.value)}
          />
        </label>
        <TrainerPicker selectedId={spriteId} onSelect={setSpriteId} />
        <div className="trainer-wallet-actions">
          {required ? (
            <button type="button" className="pa-btn pa-btn-surface" disabled={busy} onClick={onDisconnect}>Disconnect</button>
          ) : (
            <button type="button" className="pa-btn pa-btn-surface" onClick={onCancel}>Cancel</button>
          )}
          <button
            type="button"
            className="pa-btn pa-btn-primary"
            disabled={!nameOk}
            onClick={() => onSave(username, spriteId)}
          >
            Save trainer
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TrainerPicker({
  selectedId,
  onSelect,
}: {
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchTrainerSprites(query, 160), [query]);

  return (
    <div className="trainer-picker">
      <label className="trainer-picker-search">
        <span>Trainer sprite</span>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Name or id"
          aria-label="Search trainer sprites"
        />
      </label>
      <div className="trainer-picker-grid" role="listbox" aria-label="Trainer sprites">
        {results.map(entry => (
          <TrainerPickButton
            key={entry.id}
            entry={entry}
            selected={entry.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function TrainerPickButton({
  entry,
  selected,
  onSelect,
}: {
  entry: TrainerSpriteEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className={`trainer-pick${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(entry.id)}
      title={entry.name}
    >
      <img src={trainerSpriteSrc(entry.id)} alt="" width={64} height={64} loading="lazy" />
      <strong>{entry.name}</strong>
    </button>
  );
}
