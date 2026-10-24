// Equity calculation: exact enumeration where cheap (river, turn) and
// Monte Carlo sampling otherwise (flop, preflop). All sampling uses a seeded
// RNG so results are reproducible.

import { COMBOS, evaluate } from './cards';

/** mulberry32: small fast seeded PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _hero7 = new Int32Array(7);
const _vill7 = new Int32Array(7);

function showdown(hero: readonly [number, number], vill: readonly [number, number], board: ArrayLike<number>): number {
  // returns 1 win, 0.5 tie, 0 loss for hero
  for (let i = 0; i < board.length; i++) {
    _hero7[i] = board[i]!;
    _vill7[i] = board[i]!;
  }
  _hero7[board.length] = hero[0];
  _hero7[board.length + 1] = hero[1];
  _vill7[board.length] = vill[0];
  _vill7[board.length + 1] = vill[1];
  const hs = evaluate(_hero7.subarray(0, board.length + 2));
  const vs = evaluate(_vill7.subarray(0, board.length + 2));
  return hs > vs ? 1 : hs === vs ? 0.5 : 0;
}

/**
 * Exact equity of one hero combo against a weighted villain range on a
 * complete 5-card board, by enumerating villain combos (blockers removed).
 * villainWeights is indexed by combo index (COMBOS order).
 */
export function equityExactRiver(
  heroCombo: number,
  board: ArrayLike<number>,
  villainWeights: Float64Array,
): number {
  const hero = COMBOS[heroCombo]!;
  const used = new Uint8Array(52);
  used[hero[0]] = 1;
  used[hero[1]] = 1;
  for (let i = 0; i < board.length; i++) used[board[i]!] = 1;
  let num = 0;
  let den = 0;
  for (let vi = 0; vi < COMBOS.length; vi++) {
    const w = villainWeights[vi]!;
    if (w <= 0) continue;
    const v = COMBOS[vi]!;
    if (used[v[0]] || used[v[1]]) continue;
    num += w * showdown(hero, v, board);
    den += w;
  }
  return den > 0 ? num / den : 0.5;
}

/** Exact equity on the turn (4 board cards): enumerate river + villain combos. */
export function equityExactTurn(
  heroCombo: number,
  board4: ArrayLike<number>,
  villainWeights: Float64Array,
): number {
  const hero = COMBOS[heroCombo]!;
  const baseUsed = new Uint8Array(52);
  baseUsed[hero[0]] = 1;
  baseUsed[hero[1]] = 1;
  for (let i = 0; i < 4; i++) baseUsed[board4[i]!] = 1;
  const board5 = new Int32Array(5);
  for (let i = 0; i < 4; i++) board5[i] = board4[i]!;
  let num = 0;
  let den = 0;
  for (let river = 0; river < 52; river++) {
    if (baseUsed[river]) continue;
    board5[4] = river;
    num += equityExactRiver(heroCombo, board5, villainWeights);
    den += 1;
  }
  return den > 0 ? num / den : 0.5;
}

/**
 * Monte Carlo equity of one hero combo vs a weighted villain range.
 * Samples villain combos from the weights and runouts uniformly.
 */
export function equityMonteCarlo(
  heroCombo: number,
  board: ArrayLike<number>,
  villainWeights: Float64Array,
  samples: number,
  rng: () => number,
): number {
  const hero = COMBOS[heroCombo]!;
  const blocked = new Uint8Array(52);
  blocked[hero[0]] = 1;
  blocked[hero[1]] = 1;
  for (let i = 0; i < board.length; i++) blocked[board[i]!] = 1;

  // Cumulative distribution over villain combos that are not blocked.
  const cum = new Float64Array(COMBOS.length);
  let total = 0;
  for (let vi = 0; vi < COMBOS.length; vi++) {
    const v = COMBOS[vi]!;
    const w = villainWeights[vi]! > 0 && !blocked[v[0]] && !blocked[v[1]] ? villainWeights[vi]! : 0;
    total += w;
    cum[vi] = total;
  }
  if (total <= 0) return 0.5;

  const need = 5 - board.length;
  const runout = new Int32Array(5);
  for (let i = 0; i < board.length; i++) runout[i] = board[i]!;
  const deck = new Int32Array(52);
  let score = 0;
  for (let s = 0; s < samples; s++) {
    // pick villain by binary search on cum
    const x = rng() * total;
    let lo = 0;
    let hi = COMBOS.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    const vill = COMBOS[lo]!;
    // sample runout from remaining cards
    let m = 0;
    for (let c = 0; c < 52; c++) {
      if (!blocked[c] && c !== vill[0] && c !== vill[1]) deck[m++] = c;
    }
    for (let k = 0; k < need; k++) {
      const j = k + Math.floor(rng() * (m - k));
      const tmp = deck[k]!;
      deck[k] = deck[j]!;
      deck[j] = tmp;
      runout[board.length + k] = deck[k]!;
    }
    score += showdown(hero, vill, runout);
  }
  return score / samples;
}

/** Equity of every hero combo vs the villain range, using the best available method. */
export function equityVsRangeAll(
  board: ArrayLike<number>,
  villainWeights: Float64Array,
  opts: { mcSamples?: number; seed?: number } = {},
): Float64Array {
  const out = new Float64Array(COMBOS.length);
  const rng = makeRng(opts.seed ?? 1234567);
  const samples = opts.mcSamples ?? 300;
  for (let hi = 0; hi < COMBOS.length; hi++) {
    const hero = COMBOS[hi]!;
    let blockedByBoard = false;
    for (let i = 0; i < board.length; i++) {
      if (board[i] === hero[0] || board[i] === hero[1]) blockedByBoard = true;
    }
    if (blockedByBoard) {
      out[hi] = 0;
    } else if (board.length === 5) {
      out[hi] = equityExactRiver(hi, board, villainWeights);
    } else if (board.length === 4) {
      out[hi] = equityExactTurn(hi, board, villainWeights);
    } else {
      out[hi] = equityMonteCarlo(hi, board, villainWeights, samples, rng);
    }
  }
  return out;
}
