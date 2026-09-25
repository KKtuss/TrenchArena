'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useArena } from '@/lib/arena-context';
import { formatPoke } from '@/lib/api-client';
import type { DemoPlayerId } from '@/lib/protocol';

export function ArenaShell({ children }: { children: ReactNode }) {
  const { playerId, setPlayerId, connectionState, snapshot, error, clearError, connected } = useArena();
  const pathname = usePathname();
  const navItems = [
    { href: '/arena', label: 'Arena' },
    { href: '/tournaments', label: 'Tournaments' },
  ];
  const arenaActive = pathname.startsWith('/arena') || pathname.startsWith('/casual') || pathname.startsWith('/battle');
  const tournamentsActive = pathname.startsWith('/tournament');
  const isHome = pathname === '/';

  return (
    <>
      <header className={`shell-nav${isHome ? ' shell-nav-home' : ''}`}>
        <div className="shell-nav-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden>PA</span>
            <span className="brand-copy">
              <strong>
                PokeArena
                {isHome ? <span className="brand-pulse" aria-hidden /> : null}
              </strong>
              <small>Battle Stadium</small>
            </span>
          </Link>
          <nav className="nav-links" aria-label="Primary">
            {navItems.map(item => {
              const active = item.href === '/arena' ? arenaActive : tournamentsActive;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? 'active' : ''}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="shell-actions">
            <div className="trainer-control" title="Trainer profile (history coming soon)">
              <svg className="trainer-figure trainer-figure-sm" viewBox="0 0 64 96" aria-hidden>
                <ellipse cx="32" cy="12" rx="16" ry="5" fill="#0b192b" />
                <rect x="18" y="4" width="28" height="10" rx="3" fill="#163a68" />
                <circle cx="32" cy="20" r="9" fill="#f0d8b8" />
                <path d="M18 34 L32 29 L46 34 L52 90 H12 Z" fill="#1c4a86" />
                <path d="M24 34 L32 44 L40 34" fill="#0b192b" />
                <rect x="26" y="50" width="12" height="6" fill="#35a7ff" />
              </svg>
              <span className="trainer-control-copy">
                <small>Profile</small>
                <select
                  aria-label="Trainer identity"
                  value={playerId}
                  onChange={event => setPlayerId(event.target.value as DemoPlayerId)}
                >
                  <option value="demo-player-1">demo-player-1</option>
                  <option value="demo-player-2">demo-player-2</option>
                </select>
              </span>
            </div>
            <span className="wallet-chip">
              <small>POKE</small>
              <strong>{snapshot ? formatPoke(snapshot.wallet.balance) : '—'}</strong>
            </span>
            <span
              className={`connection-dot ${connected ? 'online' : ''}`}
              title={connected ? connectionState : 'offline'}
              aria-label={connected ? `Connection ${connectionState}` : 'offline'}
            />
          </div>
        </div>
      </header>
      <main className={isHome ? 'is-home' : undefined}>
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
