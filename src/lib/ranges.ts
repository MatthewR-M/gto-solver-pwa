// UI-side helpers: range construction from classes/presets, chart lookups,
// and per-class aggregation of solver output.

import { COMBOS, CLASS_COMBOS, NUM_COMBOS, classIndexOf, className } from '../../engine/cards';
import preflopData from '../data/preflop.json';

export interface PreflopData {
  meta: Record<string, unknown>;
  equityVsRandom: Record<string, number>;
  rfi: Record<string, Record<string, Record<string, number>>>;
  vsOpen: Record<
    string,
    Record<string, Record<string, { threeBet: Record<string, number>; call: Record<string, number> }>>
  >;
  vs3bet: Record<
    string,
    Record<string, Record<string, { fourBet: Record<string, number>; call: Record<string, number> }>>
  >;
}
export const PREFLOP = preflopData as unknown as PreflopData;
export const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'];

/** Classes ranked by Monte Carlo equity vs a random hand (best first). */
export const CLASSES_BY_EQUITY: number[] = (() => {
  const eq = PREFLOP.equityVsRandom;
  return Array.from({ length: 169 }, (_, i) => i).sort(
    (a, b) => (eq[className(b)] ?? 0) - (eq[className(a)] ?? 0),
  );
})();

/** Combo weights from a {className: freq} map. */
export function weightsFromClassFreq(freq: Record<string, number>): Float64Array {
  const w = new Float64Array(NUM_COMBOS);
  for (const [name, f] of Object.entries(freq)) {
    const ci = classIndexFromName(name);
    if (ci < 0) continue;
    for (const combo of CLASS_COMBOS[ci]!) w[combo] = f;
  }
  return w;
}

const _nameToClass = new Map<string, number>();
for (let i = 0; i < 169; i++) _nameToClass.set(className(i), i);
export function classIndexFromName(name: string): number {
  return _nameToClass.get(name) ?? -1;
}

/** Top X% of combos by equity vs random (fractional boundary class). */
export function topPercentRange(pct: number): Float64Array {
  const w = new Float64Array(NUM_COMBOS);
  const target = (pct / 100) * NUM_COMBOS;
  let acc = 0;
  for (const ci of CLASSES_BY_EQUITY) {
    const combos = CLASS_COMBOS[ci]!;
    if (acc + combos.length <= target) {
      for (const c of combos) w[c] = 1;
      acc += combos.length;
    } else if (acc < target) {
      const f = (target - acc) / combos.length;
      for (const c of combos) w[c] = f;
      break;
    } else break;
  }
  return w;
}

/** Remove combos blocked by board cards (and optionally by hero cards). */
export function removeBlockers(w: Float64Array, blocked: number[]): Float64Array {
  const out = new Float64Array(w);
  const set = new Set(blocked);
  for (let i = 0; i < NUM_COMBOS; i++) {
    const [a, b] = COMBOS[i]!;
    if (set.has(a) || set.has(b)) out[i] = 0;
  }
  return out;
}

/** Fraction of a range (0..1 of all combos) that has weight > 0, weight-averaged. */
export function rangeShare(w: Float64Array): number {
  let s = 0;
  for (let i = 0; i < NUM_COMBOS; i++) s += w[i]!;
  return s / NUM_COMBOS;
}

/** Per-class average weight (for grid display of a range). */
export function classWeights(w: Float64Array): Float64Array {
  const out = new Float64Array(169);
  for (let ci = 0; ci < 169; ci++) {
    const combos = CLASS_COMBOS[ci]!;
    let s = 0;
    for (const c of combos) s += w[c]!;
    out[ci] = combos.length ? s / combos.length : 0;
  }
  return out;
}

/** Combo weights from a per-class weight array (169 entries). */
export function weightsFromClassWeights(classWeightsArr: ArrayLike<number>): Float64Array {
  const w = new Float64Array(NUM_COMBOS);
  for (let ci = 0; ci < 169; ci++) {
    const f = classWeightsArr[ci] ?? 0;
    if (f > 0) for (const c of CLASS_COMBOS[ci]!) w[c] = f;
  }
  return w;
}

/** Toggle a class in a weight array between 0 and 1 (based on current majority). */
export function toggleClass(w: Float64Array, classIdx: number): Float64Array {
  const out = new Float64Array(w);
  const combos = CLASS_COMBOS[classIdx]!;
  const cur = classWeights(w)[classIdx]!;
  const next = cur > 0.5 ? 0 : 1;
  for (const c of combos) out[c] = next;
  return out;
}

export function comboClassName(c1: number, c2: number): string {
  return className(classIndexOf(c1, c2));
}
