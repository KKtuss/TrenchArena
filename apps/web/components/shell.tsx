'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { BrandMark } from '@/components/brand-mark';
import { ErrorToast } from '@/components/error-toast';
import { AnimatedAmount } from '@/components/motion';
import { TrainerName } from '@/components/profile-trainer';
import { TrainerProfileControl } from '@/components/trainer-profile';
import { useArena } from '@/lib/arena-context';
import { formatPoke, formatPokeValue, formatSolLamportsValue } from '@/lib/api-client';
import { isDemoAuthEnabled } from '@/lib/demo-auth';

export function ArenaShell({ children }: { children: ReactNode }) {
  const {
    connectionState,
    playerId,
    snapshot,
    error,
    clearError,
    connected,
    chainEconomyEnabled,
  } = useArena();
  const pathname = usePathname() ?? '';
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dismissedInvitationId, setDismissedInvitationId] = useState<string | null>(null);
  const invitation = snapshot?.openCasualRooms.find(room => (
    room.roomType === 'private'
    && room.status === 'open'
    && room.invitedPlayerId === playerId
  ));
  const navItems = [
    { href: '/arena', label: 'Arena', active: pathname.startsWith('/arena') || pathname.startsWith('/casual') || pathname.startsWith('/battle') },
    { href: '/teams', label: 'My Teams', active: pathname === '/teams' },
    { href: '/teams/builder', label: 'Team Builder', active: pathname.startsWith('/teams/builder') },
    { href: '/tournaments', label: 'Tournaments', active: pathname.startsWith('/tournament') },
    { href: '/treasury', label: 'Treasury & Economy', active: pathname.startsWith('/treasury') },
    ...(isDemoAuthEnabled()
      ? [{ href: '/profile', label: 'Profile', active: pathname.startsWith('/profile') }]
      : []),
  ];
  const isHome = pathname === '/';
  return (
    <>
      <header className="shell-nav shell-nav-stitch">
        <div className="shell-nav-inner">
          <Link href="/" className="brand">
            <BrandMark className="brand-mark" />
            <span className="brand-copy">
              <strong>POKEARENA</strong>
            </span>
          </Link>
          <button
            type="button"
            className="shell-nav-mobile-toggle"
            aria-expanded={mobileNavOpen}
            aria-controls="primary-navigation"
            aria-label={mobileNavOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setMobileNavOpen(current => !current)}
          >
            <span className="shell-nav-mobile-icon" aria-hidden>
              <i />
              <i />
              <i />
            </span>
          </button>
          <nav
            id="primary-navigation"
            className={`nav-links${mobileNavOpen ? ' mobile-nav-open' : ''}`}
            aria-label="Primary"
          >
            {navItems.map(item => (
              <Link
                key={item.href}
                href={item.href}
                className={item.active ? 'active' : ''}
                aria-current={item.active ? 'page' : undefined}
                onClick={() => setMobileNavOpen(false)}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="shell-actions">
            {chainEconomyEnabled ? (
              <span className="wallet-chip passport-chip">
                <span className="passport-chip-row passport-chip-status">
                  <small>Passport</small>
                  <strong className={
                    snapshot?.passport
                      ? (snapshot.passport.eligible ? 'is-eligible' : 'is-ineligible')
                      : 'is-pending'
                  }>
                    {snapshot?.passport
                      ? (snapshot.passport.eligible ? 'Eligible' : 'Need $20')
                      : (connected ? '—' : 'Connect')}
                  </strong>
                </span>
                <span className="passport-chip-row passport-chip-balances">
                  <span className="passport-chip-balance">
                    <small>POKE</small>
                    <strong>{snapshot ? <AnimatedAmount value={snapshot.wallet.balance} format={formatPokeValue} /> : '—'}</strong>
                  </span>
                  <span className="passport-chip-balance">
                    <small>SOL</small>
                    <strong>
                      {snapshot?.solBalances
                        ? <AnimatedAmount value={Number(snapshot.solBalances.freeLamports)} format={formatSolLamportsValue} />
                        : '—'}
                    </strong>
                  </span>
                </span>
              </span>
            ) : (
              <span className="wallet-chip">
                <small>Poke</small>
                <strong>
                  {snapshot
                    ? <AnimatedAmount value={snapshot.wallet.balance} format={formatPoke} />
                    : '—'}
                </strong>
                <span
                  className={`connection-dot ${connected ? 'online' : ''}`}
                  title={connected ? connectionState : 'offline'}
                  aria-label={connected ? `Connection ${connectionState}` : 'offline'}
                />
              </span>
            )}
            <TrainerProfileControl />
          </div>
        </div>
      </header>
      <main className={isHome ? 'is-home' : undefined}>
        <LiveFightBanner />
        <div key={pathname} className="pa-route">
          {children}
        </div>
      </main>
      {invitation && invitation.id !== dismissedInvitationId ? (
        <div className="pa-toast-stack" aria-live="polite">
          <div className="pa-toast pa-toast-invitation" role="status">
            <span>
              <strong>Fight invitation</strong>
              <br />
              You have been challenged to a private fight.
            </span>
            <Link className="pa-btn pa-btn-primary pa-btn-sm" href={`/casual/${invitation.id}`}>
              Review
            </Link>
            <button
              type="button"
              className="pa-toast-dismiss"
              onClick={() => setDismissedInvitationId(invitation.id)}
              aria-label="Dismiss fight invitation"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      <ErrorToast error={error} onDismiss={clearError} />
    </>
  );
}

function LiveFightBanner() {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { client, playerId, snapshot } = useArena();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!playerId) return null;
  const fight = snapshot?.myCasualRooms.find(room => (
    room.status === 'battling'
    && room.matchId
    && (room.creatorId === playerId || room.opponentId === playerId)
  ));
  if (!fight?.matchId || pathname === `/battle/${fight.matchId}`) return null;
  const opponentId = fight.creatorId === playerId ? fight.opponentId : fight.creatorId;

  return (
    <div className="pa-live-strip pa-fight-banner">
      <span className="pa-live-pill status-battling"><i /> Live fight</span>
      <span>
        You are still in a fight{opponentId ? <> against <TrainerName playerId={opponentId} /></> : null}. Leaving the battle tab does not end it.
        {error ? ` ${error}` : ''}
      </span>
      <Link className="pa-btn pa-btn-primary pa-btn-sm" href={`/battle/${fight.matchId}`}>Rejoin fight</Link>
      <button
        type="button"
        className="pa-btn pa-btn-danger pa-btn-sm"
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
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
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
