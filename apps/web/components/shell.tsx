'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { DemoPlayerId } from '@/lib/protocol';
import { trainerName } from '@/lib/trainers';

export function ArenaShell({ children }: { children: ReactNode }) {
  const { playerId, setPlayerId, connectionState, snapshot, error, clearError, connected } = useArena();
  const pathname = usePathname();
  const navItems = [
    { href: '/arena', label: 'Arena', active: pathname.startsWith('/arena') || pathname.startsWith('/casual') || pathname.startsWith('/battle') },
    { href: '/teams', label: 'My Teams', active: pathname === '/teams' },
    { href: '/teams/builder', label: 'Team Builder', active: pathname.startsWith('/teams/builder') },
    { href: '/tournaments', label: 'Tournaments', active: pathname.startsWith('/tournament') },
    { href: '/treasury', label: 'Treasury & Economy', active: pathname.startsWith('/treasury') },
  ];
  const isHome = pathname === '/';

  return (
    <>
      <header className="shell-nav shell-nav-stitch">
        <div className="shell-nav-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>PA</span>
            <span className="brand-copy">
              <strong>
                PokeArena
                <span className="brand-pulse" aria-hidden />
              </strong>
              <small>Battle Stadium</small>
            </span>
          </Link>
          <nav className="nav-links" aria-label="Primary">
            {navItems.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={item.active ? 'active' : ''}
                aria-current={item.active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="shell-actions">
            <span className="wallet-chip">
              <small>Poke</small>
              <strong>{snapshot ? formatPoke(snapshot.wallet.balance) : '—'}</strong>
              <span
                className={`connection-dot ${connected ? 'online' : ''}`}
                title={connected ? connectionState : 'offline'}
                aria-label={connected ? `Connection ${connectionState}` : 'offline'}
              />
            </span>
            <label className="trainer-control" title="Trainer profile">
              <span className="trainer-avatar" aria-hidden>👤</span>
              <span className="trainer-control-copy">
                <small>Profile</small>
                <select
                  aria-label="Trainer identity"
                  value={playerId}
                  onChange={event => setPlayerId(event.target.value as DemoPlayerId)}
                >
                  <option value="demo-player-1">{trainerName('demo-player-1')}</option>
                  <option value="demo-player-2">{trainerName('demo-player-2')}</option>
                </select>
              </span>
            </label>
          </div>
        </div>
      </header>
      <main className={isHome ? 'is-home' : undefined}>
        <LiveFightBanner />
        {error ? (
          <div className="error-banner">
            <div className="row">
              <span>{error}</span>
              <button type="button" className="btn" onClick={clearError}>Dismiss</button>
            </div>
          </div>
        ) : null}
        {children}
      </main>
    </>
  );
}

function LiveFightBanner() {
  const pathname = usePathname();
  const router = useRouter();
  const { client, playerId, snapshot } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fight = snapshot?.myCasualRooms.find(room => (
    room.status === 'battling'
    && room.matchId
    && (room.creatorId === playerId || room.opponentId === playerId)
  ));
  if (!fight?.matchId || pathname === `/battle/${fight.matchId}`) return null;
  const opponentId = fight.creatorId === playerId ? fight.opponentId : fight.creatorId;

  return (
    <div className="live-fight-banner">
      <span>
        You are still in a fight{opponentId ? ` against ${trainerName(opponentId)}` : ''}. Leaving the battle tab does not end it.
        {error ? ` ${error}` : ''}
      </span>
      <span className="row">
        <Link className="btn btn-primary" href={`/battle/${fight.matchId}`}>Rejoin fight</Link>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void client.request({ type: 'casual.forfeit', roomId: fight.id }).then(response => {
              if (response.type === 'casual.state') router.push(`/result/${response.room.id}`);
            }).catch(err => {
              setError(err instanceof Error ? err.message : String(err));
            }).finally(() => setBusy(false));
          }}
        >
          {busy ? 'Forfeiting…' : 'Forfeit fight'}
        </button>
      </span>
    </div>
  );
}

export function Panel({
  children,
  title,
  eyebrow,
  strong,
}: {
  children: ReactNode;
  title?: string;
  eyebrow?: string;
  strong?: boolean;
}) {
  return (
    <section className={`panel ${strong ? 'panel-strong' : ''}`}>
      {(eyebrow || title) ? (
        <div className="panel-heading">
          {eyebrow ? <div className="micro-label">{eyebrow}</div> : null}
          {title ? <h2>{title}</h2> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode;
  tone?: 'default' | 'live' | 'success' | 'danger';
}) {
  const className = tone === 'default'
    ? 'badge'
    : `badge badge-${tone}`;
  return <span className={className}>{children}</span>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <div className="page-kicker">{eyebrow}</div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </div>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <div className="micro-label">{eyebrow}</div>
        {title ? <h2>{title}</h2> : null}
      </div>
      {action}
    </div>
  );
}
