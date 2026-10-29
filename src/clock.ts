/** All time-dependent logic takes a Clock. Never call Date.now() in business code. */
export interface Clock {
  /** Current UTC instant, epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FixedClock implements Clock {
  constructor(private t: number) {}
  now() { return this.t; }
  set(t: number) { this.t = t; }
  advance(ms: number) { this.t += ms; }
}
