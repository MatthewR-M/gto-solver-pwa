import { describe, it, expect } from 'vitest';
import { CfrSolver } from '../engine/cfr';
import { buildKuhn, buildLeduc, buildRiverToy, RIVER_TOY_SOLUTION } from '../engine/games';

describe('Kuhn poker (CFR validation)', () => {
  it('reproduces the known game value -1/18 and near-zero exploitability', () => {
    const solver = new CfrSolver(buildKuhn());
    solver.run(20000);
    const value = solver.expectedValue();
    const { exploitability } = solver.exploitability();
    expect(Math.abs(value - -1 / 18)).toBeLessThan(0.002);
    expect(exploitability).toBeLessThan(0.002);
    expect(exploitability).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('Leduc Hold\'em (CFR convergence)', () => {
  it('exploitability decreases toward 0', () => {
    const solver = new CfrSolver(buildLeduc());
    solver.run(200);
    const early = solver.exploitability().exploitability;
    solver.run(4800);
    const late = solver.exploitability().exploitability;
    expect(late).toBeLessThan(early);
    expect(late).toBeLessThan(0.05); // chips; antes are 1, pots reach ~14
  }, 180_000);
});

describe('analytic river toy game (regression)', () => {
  it('matches the closed-form solution', () => {
    const tree = buildRiverToy();
    const solver = new CfrSolver(tree);
    solver.run(20000);
    const sol = RIVER_TOY_SOLUTION;
    expect(Math.abs(solver.expectedValue() - sol.gameValue)).toBeLessThan(0.35);
    expect(solver.exploitability().exploitability).toBeLessThan(0.35);

    const avg = solver.averageStrategyArray();
    const strat = (player: number, nth: number) => {
      // find the nth infoset belonging to `player`
      let seen = -1;
      for (let i = 0; i < tree.numInfosets; i++) {
        if (tree.infosetPlayer[i] === player) {
          seen++;
          if (seen === nth) {
            const off = tree.infosetActionOffset[i]!;
            return [avg[off]!, avg[off + 1]!];
          }
        }
      }
      throw new Error('infoset not found');
    };
    // Infoset creation order in buildRiverToy: P2's node is built first
    // (children before parents), then P0 nuts, then P0 air.
    const p2 = strat(1, 0)!; // [fold, call]
    const p0First = strat(0, 0)!; // [check, bet]
    const p0Second = strat(0, 1)!;
    expect(Math.abs(p2[1]! - sol.callFrequency)).toBeLessThan(0.03);
    // One of P0's infosets is nuts (bet ~1), the other air (bet ~1/3).
    const bets = [p0First[1]!, p0Second[1]!].sort((a, b) => a - b);
    expect(bets[1]!).toBeGreaterThan(0.97); // value bet the nuts
    expect(Math.abs(bets[0]! - sol.bluffFrequency)).toBeLessThan(0.03); // bluff 1/3
  }, 60_000);
});
