export type CupIconName =
  | 'arrow-left'
  | 'bolt'
  | 'check'
  | 'clipboard'
  | 'clock'
  | 'coins'
  | 'crown'
  | 'flag'
  | 'lock'
  | 'swords'
  | 'ticket'
  | 'trophy'
  | 'users';

export function CupIcon({ name, className }: { name: CupIconName; className?: string }) {
  return (
    <svg
      className={className ? `cup-icon ${className}` : 'cup-icon'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {name === 'arrow-left' ? (
        <>
          <path d="M19 12H5" />
          <path d="m11 18-6-6 6-6" />
        </>
      ) : null}
      {name === 'bolt' ? <path d="M13 2 4.5 13.5H12L11 22l8.5-11.5H12L13 2Z" /> : null}
      {name === 'check' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12.2 2.4 2.4 4.6-5.1" />
        </>
      ) : null}
      {name === 'clipboard' ? (
        <>
          <rect x="8" y="2.5" width="8" height="3.5" rx="1" />
          <path d="M16 4.2h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.2a2 2 0 0 1 2-2h2" />
          <path d="M8.5 11.5h7M8.5 15.5h5" />
        </>
      ) : null}
      {name === 'clock' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.5V12l3.2 2" />
        </>
      ) : null}
      {name === 'coins' ? (
        <>
          <ellipse cx="9" cy="15" rx="6" ry="5.2" />
          <ellipse cx="15" cy="9.2" rx="6" ry="5.2" />
        </>
      ) : null}
      {name === 'crown' ? (
        <>
          <path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 11H5L3 7Z" />
          <path d="M5 21h14" />
        </>
      ) : null}
      {name === 'flag' ? (
        <>
          <path d="M5 21V4" />
          <path d="M5 4h11l-2 4 2 4H5" />
        </>
      ) : null}
      {name === 'lock' ? (
        <>
          <rect x="5" y="10" width="14" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </>
      ) : null}
      {name === 'swords' ? (
        <>
          <path d="M14.5 17.5 3 6V3h3l11.5 11.5" />
          <path d="m13 19 6-6M16 16l4 4M19 21l2-2" />
          <path d="M9.5 6.5 21 3v3l-3.5 3.5" />
          <path d="m5 14 2.5 2.5M3 19l3.5-3.5M3 21l2-2" />
        </>
      ) : null}
      {name === 'ticket' ? (
        <>
          <path d="M4 6h16a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4V7a1 1 0 0 1 1-1Z" />
          <path d="M15 6v2M15 11v2M15 16v2" />
        </>
      ) : null}
      {name === 'trophy' ? (
        <>
          <path d="M8 21h8" />
          <path d="M12 17v4" />
          <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" />
          <path d="M17 6h2.5a2.5 2.5 0 0 1-2.5 4" />
          <path d="M7 6H4.5A2.5 2.5 0 0 0 7 10" />
        </>
      ) : null}
      {name === 'users' ? (
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      ) : null}
    </svg>
  );
}
