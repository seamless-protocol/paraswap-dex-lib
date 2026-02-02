import { parallelLimit } from 'async';
import { Logger } from 'log4js';

export class PromiseScheduler {
  private promises: (() => Promise<boolean>)[] = [];

  constructor(
    private intervalMs: number,
    private parallelLimit: number,
    private logger: Logger,
  ) {
    this.run();
  }

  public addPromise(promiseFn: () => Promise<boolean>) {
    this.promises.push(promiseFn);
  }

  private async run() {
    if (this.promises.length === 0) {
      // This scheduler is a background helper; it should not keep Node alive by itself (tests, one-off scripts, etc).
      const timer = setTimeout(this.run.bind(this), this.intervalMs);
      timer.unref();
      return;
    }
    this.logger.info(
      `start async parallel on ${this.promises.length} promises`,
    );

    const promisesToExecute = this.promises;
    this.promises = [];

    let count = 0;

    const tasks = promisesToExecute.map(p => {
      return async () => {
        try {
          const res = await p();
          if (!res) {
            this.addPromise(p);
          }
        } catch (e) {
          this.logger.warn(`scheduled promise failed`, e);
          this.addPromise(p);
        }
        ++count;
        if (count == promisesToExecute.length) {
          this.logger.info(
            `async parallel done on ${promisesToExecute.length} promises`,
          );
          const timer = setTimeout(this.run.bind(this), this.intervalMs);
          timer.unref();
        }
      };
    });
    parallelLimit(tasks, this.parallelLimit);
  }
}
