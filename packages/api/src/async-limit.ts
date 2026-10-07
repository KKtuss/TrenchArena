/**
 * Bounds how many independent jobs run at once.
 * Queued jobs keep their own results; this does not merge them.
 */
export class AsyncLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('AsyncLimiter requires a positive concurrency limit.');
    }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        work().then(resolve, reject).finally(() => {
          this.active -= 1;
          this.waiting.shift()?.();
        });
      };
      if (this.active < this.limit) start();
      else this.waiting.push(start);
    });
  }
}
