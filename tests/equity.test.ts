import { describe, it, expect } from 'vitest';
import { COMBOS, comboIndex, parseCard, parseCards } from '../engine/cards';
import { equityExactRiver, equityExactTurn, equityMonteCarlo, makeRng } from '../engine/equity';

function rangeOf(...pairs: [string, string][]): Float64Array {
  const r = new Float64Array(COMBOS.length);
  for (const [a, b] of pairs) r[comboIndex(parseCard(a), parseCard(b))] = 1;
  return r;
}

describe('equity', () => {
  const board = parseCards('Ks Qd 7c 2h 3d');

  it('exact river equity: losing hand has 0, board-playing hands tie', () => {
    // Villain KK = three kings. Hero AA = pair of aces only (board has one K).
    const heroAA = comboIndex(parseCard('As'), parseCard('Ad'));
    const vsKK = rangeOf(['Kh', 'Kd']);
    expect(equityExactRiver(heroAA, board, vsKK)).toBe(0);
    // Board is a straight (K Q J T 9): two low pocket pairs both play the
    // board and always tie.
    const boardTie = parseCards('Ks Qd Jc Th 9d');
    const heroLow = comboIndex(parseCard('2c'), parseCard('2d'));
    const vsLow = rangeOf(['3c', '3d']);
    expect(equityExactRiver(heroLow, boardTie, vsLow)).toBe(0.5);
  });

  it('Monte Carlo equity approximates exact equity', () => {
    // Flop: AA vs a random hand on Qs Js 8d measures ~0.798 at 50k samples
    // (random hands are weak on average); assert the measured band.
    const boardFlop = parseCards('Qs Js 8d');
    const heroAA = comboIndex(parseCard('Ac'), parseCard('Ah'));
    const full = new Float64Array(COMBOS.length).fill(1);
    const mc = equityMonteCarlo(heroAA, boardFlop, full, 20000, makeRng(7));
    expect(mc).toBeGreaterThan(0.74);
    expect(mc).toBeLessThan(0.86);
    // Turn: cross-check MC against exact enumeration over rivers.
    const turnBoard = parseCards('Qs Js 8d 2c');
    const exact = equityExactTurn(heroAA, turnBoard, full);
    const mcTurn = equityMonteCarlo(heroAA, turnBoard, full, 20000, makeRng(7));
    expect(Math.abs(mcTurn - exact)).toBeLessThan(0.01);
  });
});
