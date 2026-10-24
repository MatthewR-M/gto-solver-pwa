import { describe, it, expect } from 'vitest';
import { evaluate, parseCards, categoryOf } from '../engine/cards';

// Known exact counts of 7-card hand categories over all C(52,7) = 133,784,560
// hands (standard published combinatorial values).
const EXPECTED_COUNTS = [
  23294460, // high card
  58627800, // one pair
  31433400, // two pair
  6461620, // three of a kind
  6180020, // straight
  4047644, // flush
  3473184, // full house
  224848, // four of a kind
  41584, // straight flush (incl. royal)
];

describe('hand evaluator', () => {
  it('orders categories and kickers correctly', () => {
    const sf = evaluate(parseCards('As Ks Qs Js Ts 2d 3c'));
    const quads = evaluate(parseCards('Ac Ad Ah As Kd 2c 3d'));
    const fhAces = evaluate(parseCards('Ac Ad Ah Ks Kd 2c 3d'));
    const fhKings = evaluate(parseCards('Kc Kd Kh As Ad 2c 3d'));
    const flush = evaluate(parseCards('As Ks 9s 5s 2s 3d 4c'));
    const wheel = evaluate(parseCards('Ac 2d 3h 4s 5c Kd Qd'));
    const sixStraight = evaluate(parseCards('2c 3d 4h 5s 6c Kd Qd'));
    expect(sf).toBeGreaterThan(quads);
    expect(quads).toBeGreaterThan(fhAces);
    expect(fhAces).toBeGreaterThan(fhKings);
    expect(fhKings).toBeGreaterThan(flush);
    expect(wheel).toBeLessThan(sixStraight); // wheel is a 5-high straight
    expect(categoryOf(wheel)).toBe(4);
    // identical hands tie exactly
    expect(evaluate(parseCards('Ac Kd Qh Js Tc 2d 3c'))).toBe(
      evaluate(parseCards('Ad Kc Qs Jh Ts 2h 3d')),
    );
  });

  it(
    'matches brute-force enumeration of all 7-card hands',
    () => {
      const counts = new Array<number>(9).fill(0);
      const cards = new Int32Array(7);
      const idx = [0, 1, 2, 3, 4, 5, 6];
      let total = 0;
      for (;;) {
        for (let i = 0; i < 7; i++) cards[i] = idx[i]!;
        counts[categoryOf(evaluate(cards))]!++;
        total++;
        let i = 6;
        while (i >= 0 && idx[i] === 45 + i) i--;
        if (i < 0) break;
        idx[i]!++;
        for (let j = i + 1; j < 7; j++) idx[j] = idx[j - 1]! + 1;
      }
      expect(total).toBe(133784560);
      expect(counts).toEqual(EXPECTED_COUNTS);
    },
    300_000,
  );
});
