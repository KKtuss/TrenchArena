'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { MOTION_MS, lerp } from '@/lib/motion';

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);
  return reduced;
}

/**
 * Follows an authoritative number. The first value renders as-is.
 * Later changes interpolate from the last shown value and finish on the exact target.
 */
/** Class token for a value that just dropped or rose. Empty on first paint. */
export function useDeltaPulse(value: number | null): '' | 'hit' | 'heal' {
  const reduced = usePrefersReducedMotion();
  const previous = useRef<number | null>(null);
  const [pulse, setPulse] = useState<'' | 'hit' | 'heal'>('');

  useEffect(() => {
    const prior = previous.current;
    previous.current = value;
    if (reduced || prior == null || value == null || prior === value) return undefined;
    setPulse(value < prior ? 'hit' : 'heal');
    const timer = window.setTimeout(() => setPulse(''), MOTION_MS.medium);
    return () => window.clearTimeout(timer);
  }, [reduced, value]);

  return pulse;
}

export function useAnimatedNumber(value: number | null): number | null {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    if (value == null) {
      shownRef.current = null;
      setShown(null);
      return undefined;
    }
    const from = shownRef.current;
    if (from == null || reduced || from === value) {
      shownRef.current = value;
      setShown(value);
      return undefined;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / MOTION_MS.impact);
      const next = t >= 1 ? value : lerp(from, value, t);
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced, value]);

  return shown;
}

export function AnimatedAmount({
  value,
  format,
}: {
  value: number | null | undefined;
  format: (value: number) => string;
}) {
  const shown = useAnimatedNumber(value ?? null);
  if (value == null || shown == null) return <>{'—'}</>;
  return <>{format(shown === value ? value : shown)}</>;
}

export function BattleIntro({
  active,
  restoring,
  children,
}: {
  active: boolean;
  restoring: boolean;
  children: ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<'in' | 'leave' | 'done'>('in');

  useEffect(() => {
    if (!active) return undefined;
    if (reduced) {
      setPhase('done');
      return undefined;
    }
    setPhase('in');
    const hold = restoring ? MOTION_MS.impact : MOTION_MS.impact * 2;
    const leaveAt = window.setTimeout(() => setPhase('leave'), hold);
    const doneAt = window.setTimeout(() => setPhase('done'), hold + MOTION_MS.short);
    return () => {
      window.clearTimeout(leaveAt);
      window.clearTimeout(doneAt);
    };
  }, [active, reduced, restoring]);

  if (!active || phase === 'done') return null;
  return (
    <div
      className={`pa-battle-intro${phase === 'leave' ? ' is-leave' : ''}${restoring ? ' is-restore' : ''}`}
      role="status"
    >
      {children}
    </div>
  );
}
