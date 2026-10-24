// Preflop chart generation from first principles.
//
// METHOD (read this before trusting the output):
//   1. Every hand class's all-in equity is computed by Monte Carlo sampling
//      with this project's own evaluator (seeded, reproducible). No external
//      chart, solver output, or published range is used as input.
//   2. RFI (raise-first-in) ranges: classes are ranked by equity vs a random
//      hand; each position opens the top classes up to a target share of all
//      combos (UTG 13%, MP 16%, CO 22%, BTN 40%, SB 35%). The boundary class
//      is opened at a fractional frequency so the target is hit closely.
//   3. vs-open responses: each class's equity vs the opener's actual range
//      is computed by Monte Carlo. Responses use fixed equity thresholds:
//        - 3-bet for value at equity >= 0.56
//        - call at equity >= a position/price threshold (BB 0.435 closes
//          the action and gets the best price; SB 0.455; in-position 0.45)
//        - suited classes with equity in [0.40, callThreshold) 3-bet at 50%
//          as bluffs (a modelling choice so the 3-bet range is not purely
//          value; it is NOT a solver result)
//   4. vs-3-bet (opener facing a 3-bet): 4-bet at equity >= 0.55 vs the
//      3-bet range, call in [0.47, 0.55).
//   5. Stack depths: 100bb is the base. 50bb shifts call/4-bet thresholds
//      +0.01 and drops bluff 3-bets; 200bb shifts them -0.01. RFI targets do
//      not change with depth (a documented simplification).
//
// These charts are a HEURISTIC MODEL built on equities and hand-picked
// thresholds. They are not CFR output and not equilibrium strategies; treat
// them as a reasonable starting reference, which is how the app labels them.
//
// Run: npm run gen:preflop   (writes src/data/preflop.json)

import * as fs from 'node:fs';
import { COMBOS, CLASS_COMBOS, className, evaluate } from '../engine/cards';
import { makeRng } from '../engine/equity';

const SEED = 20261023;
const POSITIONS = ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'] as const;
type Pos = (typeof POSITIONS)[number];
const RFI_POSITIONS: Pos[] = ['UTG', 'MP', 'CO', 'BTN', 'SB'];
const RFI_TARGET: Record<string, number> = { UTG: 0.13, MP: 0.16, CO: 0.22, BTN: 0.40, SB: 0.35 };
const DEPTHS = [50, 100, 200];

const _h = new Int32Array(7);
const _v = new Int32Array(7);

function showdown(hero: readonly [number, number], vill: readonly [number, number], board: ArrayLike<number>): number {
  for (let i = 0; i < 5; i++) {
    _h[i] = board[i]!;
    _v[i] = board[i]!;
  }
  _h[5] = hero[0];
  _h[6] = hero[1];
  _v[5] = vill[0];
  _v[6] = vill[1];
  const hs = evaluate(_h);
  const vs = evaluate(_v);
  return hs > vs ? 1 : hs === vs ? 0.5 : 0;
}

const _deck = new Int32Array(52);
function sampleBoard(rng: () => number, blocked: Uint8Array, out: Int32Array): void {
  let m = 0;
  for (let c = 0; c < 52; c++) if (!blocked[c]) _deck[m++] = c;
  for (let k = 0; k < 5; k++) {
    const j = k + Math.floor(rng() * (m - k));
    const tmp = _deck[k]!;
    _deck[k] = _deck[j]!;
    _deck[j] = tmp;
    out[k] = _deck[k]!;
  }
}

/** Equity of a hand class vs a weighted combo range (weights per combo). */
function classEquityVsRange(
  classIdx: number,
  rangeWeights: Float64Array | null, // null = random hand
  samples: number,
  rng: () => number,
): number {
  const heroCombos = CLASS_COMBOS[classIdx]!;
  const board = new Int32Array(5);
  let score = 0;
  let used = 0;
  for (let s = 0; s < samples; s++) {
    const hero = COMBOS[heroCombos[Math.floor(rng() * heroCombos.length)]!]!;
    // villain: weighted sample over combos not conflicting with hero
    let vill: readonly [number, number] | null = null;
    for (let tries = 0; tries < 40 && !vill; tries++) {
      let cand: number;
      if (rangeWeights) {
        // rejection-sample by weight (weights are 0/1 or fractional freq *
        // class weight in our generated ranges; use accept prob = weight)
        cand = Math.floor(rng() * COMBOS.length);
        if (rng() > rangeWeights[cand]!) continue;
      } else {
        cand = Math.floor(rng() * COMBOS.length);
      }
      const c = COMBOS[cand]!;
      if (c[0] === hero[0] || c[0] === hero[1] || c[1] === hero[0] || c[1] === hero[1]) continue;
      vill = c;
    }
    if (!vill) continue;
    const blocked = new Uint8Array(52);
    blocked[hero[0]] = 1;
    blocked[hero[1]] = 1;
    blocked[vill[0]] = 1;
    blocked[vill[1]] = 1;
    sampleBoard(rng, blocked, board);
    score += showdown(hero, vill, board);
    used++;
  }
  return used > 0 ? score / used : 0.5;
}

/** Convert a {classIdx -> freq} map into range weights per combo. */
function weightsFromFreq(freq: Map<number, number>): Float64Array {
  const w = new Float64Array(COMBOS.length);
  for (const [ci, f] of freq) {
    for (const combo of CLASS_COMBOS[ci]!) w[combo] = f;
  }
  return w;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

interface ChartOut {
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

function main(): void {
  const rng = makeRng(SEED);
  const out: ChartOut = {
    meta: {
      generatedBy: 'scripts/generate-preflop.ts',
      method:
        'Monte Carlo equities from this project\'s evaluator + documented heuristic thresholds. NOT solver/CFR output.',
      seed: SEED,
      positions: POSITIONS,
      rfiTargets: RFI_TARGET,
      depths: DEPTHS,
    },
    equityVsRandom: {},
    rfi: {},
    vsOpen: {},
    vs3bet: {},
  };

  // 1) Equity vs random for all 169 classes.
  console.log('Computing equity vs random per class...');
  const eqRandom = new Float64Array(169);
  for (let ci = 0; ci < 169; ci++) {
    eqRandom[ci] = classEquityVsRange(ci, null, 20000, rng);
    out.equityVsRandom[className(ci)] = round2(eqRandom[ci]!);
  }

  // Rank classes by equity vs random (ties: pairs first by rank via class index order).
  const ranked = Array.from({ length: 169 }, (_, i) => i).sort((a, b) => eqRandom[b]! - eqRandom[a]!);
  const totalCombos = 1326;

  // 2) RFI ranges (same at all depths — documented simplification).
  const rfiFreq = new Map<string, Map<number, number>>(); // pos -> class -> freq
  for (const pos of RFI_POSITIONS) {
    const target = RFI_TARGET[pos]! * totalCombos;
    const freq = new Map<number, number>();
    let acc = 0;
    for (const ci of ranked) {
      const n = CLASS_COMBOS[ci]!.length;
      if (acc + n <= target) {
        freq.set(ci, 1);
        acc += n;
      } else if (acc < target) {
        freq.set(ci, round2((target - acc) / n));
        acc = target;
        break;
      } else break;
    }
    rfiFreq.set(pos, freq);
    const chart: Record<string, number> = {};
    for (const [ci, f] of freq) if (f > 0) chart[className(ci)] = f;
    for (const d of DEPTHS) {
      out.rfi[String(d)] ??= {};
      out.rfi[String(d)]![pos] = chart;
    }
    console.log(`RFI ${pos}: ${(acc / totalCombos * 100).toFixed(1)}% of combos, ${freq.size} classes`);
  }

  // 3+4) vs-open and vs-3-bet per depth.
  for (const d of DEPTHS) {
    const key = String(d);
    out.vsOpen[key] = {};
    out.vs3bet[key] = {};
    const depthShift = d === 50 ? 0.01 : d === 200 ? -0.01 : 0;
    for (const opener of RFI_POSITIONS) {
      const openWeights = weightsFromFreq(rfiFreq.get(opener)!);
      out.vsOpen[key]![opener] = {};
      out.vs3bet[key]![opener] = {};
      const responders = POSITIONS.slice(POSITIONS.indexOf(opener) + 1);
      for (const resp of responders) {
        const callT = (resp === 'BB' ? 0.435 : resp === 'SB' ? 0.455 : 0.45) + depthShift;
        const threeBet: Record<string, number> = {};
        const call: Record<string, number> = {};
        const threeBetFreq = new Map<number, number>();
        for (let ci = 0; ci < 169; ci++) {
          const eq = classEquityVsRange(ci, openWeights, 3000, rng);
          const suited = className(ci).endsWith('s');
          if (eq >= 0.56) {
            threeBet[className(ci)] = 1;
            threeBetFreq.set(ci, 1);
          } else if (eq >= callT) {
            call[className(ci)] = 1;
          } else if (suited && d !== 50 && eq >= 0.4 && eq < callT) {
            threeBet[className(ci)] = 0.5;
            threeBetFreq.set(ci, 0.5);
          }
        }
        out.vsOpen[key]![opener]![resp] = { threeBet, call };
        // Opener facing this 3-bet.
        if (threeBetFreq.size > 0) {
          const tbWeights = weightsFromFreq(threeBetFreq);
          const fourBet: Record<string, number> = {};
          const callVs3: Record<string, number> = {};
          for (let ci = 0; ci < 169; ci++) {
            if (!rfiFreq.get(opener)!.has(ci)) continue;
            const eq = classEquityVsRange(ci, tbWeights, 2000, rng);
            if (eq >= 0.55 + depthShift) fourBet[className(ci)] = 1;
            else if (eq >= 0.47 + depthShift) callVs3[className(ci)] = 1;
          }
          out.vs3bet[key]![opener]![resp] = { fourBet, call: callVs3 };
        }
        console.log(
          `${key}bb vs ${opener} open, ${resp}: 3bet ${Object.keys(threeBet).length} classes, call ${Object.keys(call).length}`,
        );
      }
    }
  }

  const dest = new URL('../src/data/preflop.json', import.meta.url);
  fs.mkdirSync(new URL('../src/data/', import.meta.url), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`Wrote ${dest.pathname} (${(fs.statSync(dest).size / 1024).toFixed(0)} KB)`);
}

main();
