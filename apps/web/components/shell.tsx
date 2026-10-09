'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

import { ErrorToast } from '@/components/error-toast';
import { AnimatedAmount } from '@/components/motion';
import { TrainerName } from '@/components/profile-trainer';
import { TrainerProfileControl } from '@/components/trainer-profile';
import { useArena } from '@/lib/arena-context';
import { formatPoke, formatPokeAtomsValue, formatPokeValue, formatSolLamportsValue } from '@/lib/api-client';
import { isDemoAuthEnabled } from '@/lib/demo-auth';

const backdropZoomScale = 1.94;
const backdropZoomMs = 460;
const LOBBY_STATUSES = new Set(['open', 'pending_deposit', 'full', 'drafting', 'ready', 'starting']);

function readBackdropScale(image: HTMLElement) {
  const transform = getComputedStyle(image).transform;
  if (!transform || transform === 'none') return 1;
  const match = /matrix(?:3d)?\(([^)]+)\)/.exec(transform);
  if (!match?.[1]) return 1;
  const parts = match[1].split(',').map(part => Number(part.trim()));
  const scale = parts[0];
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

type BackdropZoom = {
  from: number;
  to: number;
  elapsed: number;
  duration: number;
};

type BackdropMotion = {
  scale: number | null;
  zoom: BackdropZoom | null;
  ticking: boolean;
  lastFrame: number;
};

function backdropMotion(): BackdropMotion {
  const host = window as Window & { __paBackdrop?: BackdropMotion };
  host.__paBackdrop ??= { scale: null, zoom: null, ticking: false, lastFrame: 0 };
  return host.__paBackdrop;
}

function applyBackdropScale(scale: number) {
  const image = document.querySelector('.site-backdrop img');
  if (!(image instanceof HTMLImageElement)) return;
  image.style.transform = `scale(${scale})`;
  const backdrop = image.parentElement;
  if (!(backdrop instanceof HTMLElement)) return;
  const amount = Math.min(1, Math.max(0, (scale - 1) / (backdropZoomScale - 1)));
  backdrop.style.setProperty('--backdrop-dim', amount.toFixed(3));
}

function easeInOut(progress: number) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

function tickBackdropZoom(now: number) {
  const motion = backdropMotion();
  const zoom = motion.zoom;
  if (!zoom) {
    motion.ticking = false;
    return;
  }
  const delta = motion.lastFrame ? Math.min(32, now - motion.lastFrame) : 16;
  motion.lastFrame = now;
  zoom.elapsed += delta;
  const linear = Math.min(1, zoom.elapsed / zoom.duration);
  const progress = easeInOut(linear);
  const scale = zoom.from + (zoom.to - zoom.from) * progress;
  motion.scale = scale;
  applyBackdropScale(scale);
  if (linear >= 1) {
    motion.zoom = null;
    motion.ticking = false;
    motion.lastFrame = 0;
    return;
  }
  window.setTimeout(() => tickBackdropZoom(performance.now()), 16);
}

function rememberLeavingRoute() {
  const route = document.querySelector('.pa-route');
  if (!(route instanceof HTMLElement)) return;
  document.querySelectorAll('.pa-route-leave-clone').forEach(node => node.remove());
  const clone = route.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return;
  const rect = route.getBoundingClientRect();
  clone.classList.remove('is-held', 'is-arriving');
  clone.classList.add('pa-route-leave-clone');
  clone.setAttribute('aria-hidden', 'true');
  clone.style.top = `${rect.top}px`;
  clone.style.left = `${rect.left}px`;
  clone.style.width = `${rect.width}px`;
  document.body.appendChild(clone);
  route.classList.add('is-held');
  window.setTimeout(() => clone.remove(), 280);
}

function playBackdropZoom(image: HTMLImageElement, to: number, fromClick: boolean) {
  const motion = backdropMotion();
  if (motion.zoom?.to === to) return;
  if (!motion.zoom && motion.scale === to) {
    applyBackdropScale(to);
    return;
  }

  const from = motion.zoom
    ? (motion.scale ?? readBackdropScale(image))
    : (fromClick ? readBackdropScale(image) : (motion.scale ?? to));
  const firstPaint = !fromClick && motion.scale == null && !motion.zoom;
  motion.scale = to;
  if (firstPaint || Math.abs(from - to) < 0.01) {
    motion.zoom = null;
    motion.scale = to;
    applyBackdropScale(to);
    return;
  }

  motion.zoom = { from, to, elapsed: 0, duration: backdropZoomMs };
  motion.scale = from;
  motion.lastFrame = 0;
  applyBackdropScale(from);
  if (!motion.ticking) {
    motion.ticking = true;
    window.setTimeout(() => tickBackdropZoom(performance.now()), 16);
  }
}

export function ArenaShell({ children }: { children: ReactNode }) {
  const {
    connectionState,
    playerId,
    snapshot,
    error,
    clearError,
    stakeRefund,
    clearStakeRefund,
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
  const lobby = snapshot?.myCasualRooms.find(room => (
    LOBBY_STATUSES.has(room.status)
    && (room.creatorId === playerId || room.opponentId === playerId)
  ));
  const showLobbyToast = Boolean(lobby && pathname !== `/casual/${lobby.id}`);
  const showInvitation = Boolean(invitation && invitation.id !== dismissedInvitationId);

  useEffect(() => {
    if (!stakeRefund) return undefined;
    const timer = window.setTimeout(() => clearStakeRefund(), 8_000);
    return () => window.clearTimeout(timer);
  }, [stakeRefund, clearStakeRefund]);
  const navItems = [
    { href: '/arena', label: 'Arena', active: pathname.startsWith('/arena') || pathname.startsWith('/casual') || pathname.startsWith('/battle') },
    { href: '/teams', label: 'My Teams', active: pathname === '/teams' },
    { href: '/teams/builder', label: 'Team Builder', active: pathname.startsWith('/teams/builder') },
    { href: '/tournaments', label: 'Tournaments', active: pathname.startsWith('/tournament') },
    { href: '/leaderboard', label: 'Leaderboard', active: pathname.startsWith('/leaderboard') },
    { href: '/treasury', label: 'Treasury & Economy', active: pathname.startsWith('/treasury') },
    ...(isDemoAuthEnabled()
      ? [{ href: '/profile', label: 'Profile', active: pathname.startsWith('/profile') }]
      : []),
  ];
  const isHome = pathname === '/';

  useLayoutEffect(() => {
    const route = document.querySelector('.pa-route');
    if (!(route instanceof HTMLElement)) return;
    const leaving = document.querySelector('.pa-route-leave-clone');
    if (!route.classList.contains('is-held') && !leaving) return;
    route.classList.remove('is-held', 'is-arriving');
    void route.offsetWidth;
    route.classList.add('is-arriving');
  }, [pathname]);

  useEffect(() => {
    const image = document.querySelector('.site-backdrop img');
    if (!(image instanceof HTMLImageElement)) return;

    const to = pathname === '/' ? 1 : backdropZoomScale;
    playBackdropZoom(image, to, false);
  }, [pathname]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a');
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank') return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      rememberLeavingRoute();
      const image = document.querySelector('.site-backdrop img');
      if (!(image instanceof HTMLImageElement)) return;
      playBackdropZoom(image, url.pathname === '/' ? 1 : backdropZoomScale, true);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  return (
    <>
      <header className="shell-nav shell-nav-stitch">
        <div className="shell-nav-inner">
          <Link href="/" className="shell-wordmark" aria-label="PokeArena home">
            <img src="/brand/pokearena-wordmark.png" alt="" />
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
            <div className="shell-wallet">
              <TrainerProfileControl />
              <div className="shell-passport-menu">
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
                          ? (snapshot.passport.eligible
                            ? 'Eligible'
                            : `Need $${(snapshot.passport.thresholdUsdCents / 100).toFixed(0)}`)
                          : (connected ? '—' : 'Connect')}
                      </strong>
                    </span>
                    <span className="passport-chip-row passport-chip-balances">
                      <span className="passport-chip-balance">
                        <small>POKE</small>
                        <strong>{snapshot?.passport
                          ? <AnimatedAmount value={Number(snapshot.passport.liquidAtoms)} format={formatPokeAtomsValue} />
                          : '—'}
                        </strong>
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
              </div>
            </div>
          </div>
        </div>
      </header>
      <main className={isHome ? 'is-home' : undefined}>
        <LiveFightBanner />
        <div key={pathname} className="pa-route">
          {children}
        </div>
      </main>
      {showLobbyToast || showInvitation || stakeRefund ? (
        <div className="pa-toast-stack" aria-live="polite">
          {stakeRefund ? (
            <div className="pa-toast pa-toast-refund" role="status">
              <span>
                <strong>Stake refunded</strong>
                <br />
                {stakeRefund}
              </span>
              <button
                type="button"
                className="pa-toast-dismiss"
                onClick={clearStakeRefund}
                aria-label="Dismiss refund notice"
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {showLobbyToast && lobby ? (
            <div className="pa-toast pa-toast-lobby" role="status">
              <span>
                <strong>In a lobby</strong>
                <br />
                You are currently in a lobby.
              </span>
              <Link className="pa-btn pa-btn-primary pa-btn-sm" href={`/casual/${lobby.id}`}>
                Back to lobby
              </Link>
            </div>
          ) : null}
          {showInvitation && invitation ? (
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
          ) : null}
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
