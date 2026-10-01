export function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden focusable="false">
      <g transform="rotate(-45 32 32)">
        <path
          fill="var(--blue)"
          transform="translate(1.75 0)"
          d="M6.098 29.75A26 26 0 0 1 57.902 29.75L36.348 29.75A6.5 6.5 0 0 0 24.152 29.75Z"
        />
        <path
          fill="var(--text)"
          transform="translate(-1.75 0)"
          d="M57.902 34.25A26 26 0 0 1 6.098 34.25L27.652 34.25A6.5 6.5 0 0 0 39.848 34.25Z"
        />
      </g>
    </svg>
  );
}
