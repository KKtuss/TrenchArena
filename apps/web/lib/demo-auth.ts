/** Public builds leave this unset. Local `next dev` may set it in `.env.development`. */
export function isDemoAuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_POKEARENA_ALLOW_DEMO_AUTH === 'true';
}
