export function BrandMark({ className }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src="/brand/pokearena-mark.png"
      alt=""
      width={64}
      height={64}
      decoding="async"
      aria-hidden
    />
  );
}
