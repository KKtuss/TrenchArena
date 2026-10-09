import type { CSSProperties } from 'react';

export function CupMeter({ value, max, className }: { value: number; max: number; className?: string }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const style = { '--cup-fill': `${Math.round(ratio * 100)}%` } as CSSProperties;
  return (
    <div className={`cup-meter${ratio >= 1 ? ' is-full' : ''}${className ? ` ${className}` : ''}`} aria-hidden>
      <i style={style} />
    </div>
  );
}
