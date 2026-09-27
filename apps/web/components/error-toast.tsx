'use client';

import { useEffect } from 'react';

export function ErrorToast({
  error,
  onDismiss,
  durationMs = 6_000,
}: {
  error: string | null;
  onDismiss?: () => void;
  durationMs?: number;
}) {
  useEffect(() => {
    if (!error || !onDismiss) return undefined;
    const timer = window.setTimeout(() => onDismiss(), durationMs);
    return () => window.clearTimeout(timer);
  }, [error, onDismiss, durationMs]);

  if (!error) return null;

  return (
    <div className="pa-toast-stack" aria-live="polite">
      <div className="pa-toast pa-toast-error" role="status">
        <span>{error}</span>
        {onDismiss ? (
          <button type="button" className="pa-toast-dismiss" onClick={onDismiss} aria-label="Dismiss">
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
