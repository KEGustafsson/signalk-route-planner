/**
 * How fast this machine does signalk-underkeel's work units, measured from the plans it runs
 * (plan §6): no benchmark, and no plan's result depends on it, so a request gives the same answer
 * on any machine. It only says what a work budget means here in seconds.
 */

/** Plans smaller than this say little about the rate: their time is mostly fixed costs. */
const MIN_WORK = 100_000;

/** Each plan's weight against the ones before it, so the rate follows a machine that changes. */
const DECAY = 0.8;

export class WorkRate {
  private units = 0;
  private ms = 0;
  private count = 0;

  /** One plan: the work units it did, and how long it took, ms. */
  record(work: unknown, elapsedMs: number): void {
    if (typeof work !== "number" || !(work >= MIN_WORK) || !(elapsedMs > 0)) {
      return;
    }
    this.units = this.units * DECAY + work;
    this.ms = this.ms * DECAY + elapsedMs;
    this.count++;
  }

  /** Work units a second here, once a plan has been measured. */
  unitsPerSecond(): number | undefined {
    return this.count > 0 ? (this.units / this.ms) * 1000 : undefined;
  }

  get plans(): number {
    return this.count;
  }

  /** What `units` take here, seconds, once a plan has been measured. */
  secondsFor(units: number): number | undefined {
    const rate = this.unitsPerSecond();
    return rate === undefined ? undefined : units / rate;
  }
}

/** "1.2 M work units ≈ 2.8 s here", or the budget alone before a plan has been measured. */
export function budgetText(units: number, seconds: number | undefined): string {
  const amount = `${(units / 1e6).toFixed(1)} M work units`;
  if (seconds === undefined) {
    return amount;
  }
  return `${amount} ≈ ${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))} s here`;
}
