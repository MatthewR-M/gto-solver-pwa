import { describe, it, expect } from 'vitest';
import { COMBOS, CLASS_COMBOS, parseClass, parseCards } from '../engine/cards';
import { PostflopConfig, PostflopSession, solvePostflop } from '../engine/postflop';

function fullRange(): Float64Array {
  return new Float64Array(COMBOS.length).fill(1);
}
function classRange(names: string[]): Float64Array {
  const r = new Float64Array(COMBOS.length);
  for (const nm of names) for (const ci of CLASS_COMBOS[parseClass(nm)]!) r[ci] = 1;
  return r;
}

describe('postflop solver', () => {
  it('bets a dominating hand: AA vs a mixed flop range', () => {
    // AA on Qs Js 8d against made hands, pairs and draws with fractional
    // equities. Checking can never be right here: worse hands call a
    // half-pot bet with 25%+ equity, and folders surrender the pot.
    const cfg: PostflopConfig = {
      board: parseCards('Qs Js 8d'),
      rangeOOP: classRange(['AA']),
      rangeIP: classRange(['T9s', 'KTs', '55', 'KQo', 'A5s']),
      pot: 100,
      stack: 200,
      betSizes: [0.5, 1.0],
      maxRaises: 1,
      numBuckets: 4,
      mcSamples: 400,
      bucketEquitySamples: 800,
    };
    const sol = solvePostflop(cfg, { iterations: 3000 });
    const bet50 = sol.aggregate[0].get('Bet 50') ?? 0;
    expect(bet50).toBeGreaterThan(0.8);
    expect(sol.exploitabilityPctPot).toBeLessThan(1);
  }, 120_000);

  it('refuses oversized trees with a clear error before solving', () => {
    const cfg: PostflopConfig = {
      board: parseCards('Qs Js 8d'),
      rangeOOP: fullRange(),
      rangeIP: fullRange(),
      pot: 100,
      stack: 1000,
      betSizes: [0.25, 0.5, 1.0, 1.5],
      maxRaises: 4,
      numBuckets: 80,
    };
    expect(() => new PostflopSession(cfg, 16 * 1024 * 1024)).toThrowError(/too large/i);
  }, 60_000);

  it('is deterministic for a fixed seed and supports stop/resume', () => {
    const cfg: PostflopConfig = {
      board: parseCards('As Kd 7c 2h 3d'),
      rangeOOP: fullRange(),
      rangeIP: fullRange(),
      pot: 100,
      stack: 200,
      betSizes: [0.5],
      maxRaises: 1,
      numBuckets: 6,
    };
    const a = new PostflopSession(cfg);
    a.step(300);
    const b = new PostflopSession(cfg);
    b.step(150);
    b.step(150); // resumed == continuous, same iteration count
    expect(a.result().gameValue).toBeCloseTo(b.result().gameValue, 10);
    const c = solvePostflop(cfg, { iterations: 300 });
    expect(c.gameValue).toBeCloseTo(a.result().gameValue, 10);
  }, 120_000);
});
