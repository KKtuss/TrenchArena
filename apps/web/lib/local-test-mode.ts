/** Enabled only by the local development environment. */
export function isLocalTestMode(): boolean {
  return process.env.NEXT_PUBLIC_POKEARENA_LOCAL_TEST_MODE === 'true';
}
