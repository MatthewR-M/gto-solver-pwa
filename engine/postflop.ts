// Heads-up postflop solver over an abstracted game:
//
//   * Card abstraction: each player's combos are grouped into N buckets by
//     equity percentile against the opposing range (equal range-weight per
//     bucket). A combo's strategy is its bucket's strategy.
//   * Betting abstraction: a single street of betting (the street the board
//     is on) with configurable bet sizes (fractions of the pot, plus all-in)
//     and a raise cap. When the street's betting closes, the hand goes to a
//     showdown whose payoff uses a precomputed bucket-vs-bucket equity
//     matrix (Monte Carlo over the remaining runout, seeded).
//
// Documented approximations (also surfaced in the UI and README):
//   1. Future streets are NOT modelled as betting rounds; they collapse
//      into showdown equity. Equity realization is assumed perfect.
//   2. The root chance node deals buckets independently for the two players
//      (probabilities proportional to bucket range weights), so card removal
//      *between* the two players' buckets is ignored. Card removal vs the
//      board is respected.
//   3. Exploitability is computed exactly, but for the ABSTRACT game — it is
//      a lower bound on the exploitability of the induced full-game
//      strategy, not a measurement of it.
//
// Utilities are player 0's (the out-of-position player's) net chips relative
// to owning half the starting pot; the starting pot is treated as sunk
// equally by both players.

import { COMBOS } from './cards';
import { equityVsRangeAll, makeRng } from './equity';
import { TreeBuilder, GameTree, CfrSolver, BYTES_PER_NODE, BYTES_PER_INFOSET_ACTION } from './cfr';
import { evaluate } from './cards';

export interface PostflopConfig {
  board: number[]; // 3, 4 or 5 cards
  rangeOOP: Float64Array; // combo weights, player 0 (out of position, acts first)
  rangeIP: Float64Array; // combo weights, player 1 (in position)
  pot: number; // pot at the start of the street
  stack: number; // effective stack behind for BOTH players at street start
  betSizes: number[]; // bet/raise sizes as fractions of the current pot
  maxRaises?: number; // default 2
  numBuckets: number; // card-abstraction buckets per player
  mcSamples?: number; // Monte Carlo samples for flop equity (default 300)
  bucketEquitySamples?: number; // samples per bucket pair (default 600)
  seed?: number;
}

export interface InfosetResult {
  id: number;
  player: 0 | 1;
  bucket: number;
  history: string;
  actions: { label: string; freq: number }[];
}

export interface PostflopMeta {
  bucketOf: [Int16Array, Int16Array]; // per player: combo -> bucket (-1 if dead)
  bucketWeight: [Float64Array, Float64Array];
  equity: [Float64Array, Float64Array]; // per combo vs opposing range
  bucketEquity: Float64Array; // numBuckets x numBuckets, P0 bucket equity
  infosetKeys: string[];
  actionLabels: string[][];
  numBuckets: number;
}

export interface SolveOptions {
  iterations?: number;
  timeBudgetMs?: number;
  shouldStop?: () => boolean;
  onProgress?: (iterations: number, exploitabilityPctPot: number | null) => void;
  maxBytes?: number; // refuse trees estimated above this (default 250 MB)
}

export interface PostflopSolution {
  iterations: number;
  exploitability: number; // chips (abstract game)
  exploitabilityPctPot: number; // exploitability / starting pot * 100
  gameValue: number; // P0 (OOP) EV in chips, relative to half the starting pot
  treeNodes: number;
  numInfosets: number;
  estimatedBytes: number;
  infosets: InfosetResult[];
  /** Root aggregate action frequencies for each player, weighted by range. */
  aggregate: [Map<string, number>, Map<string, number>];
  /** Root strategy per bucket for each player: [player][bucket] -> label -> freq */
  rootByBucket: [Map<string, number>[], Map<string, number>[]];
  meta: PostflopMeta;
}

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;

function validateConfig(cfg: PostflopConfig): void {
  if (![3, 4, 5].includes(cfg.board.length)) throw new Error('Board must have 3, 4 or 5 cards.');
  if (new Set(cfg.board).size !== cfg.board.length) throw new Error('Board has duplicate cards.');
  if (cfg.pot <= 0) throw new Error('Pot must be positive.');
  if (cfg.stack <= 0) throw new Error('Stack must be positive.');
  if (cfg.numBuckets < 2) throw new Error('Need at least 2 buckets.');
  for (const [name, range] of [
    ['OOP', cfg.rangeOOP],
    ['IP', cfg.rangeIP],
  ] as const) {
    let total = 0;
    for (let i = 0; i < COMBOS.length; i++) {
      const [a, b] = COMBOS[i]!;
      if (cfg.board.includes(a) || cfg.board.includes(b)) continue;
      total += range[i]!;
    }
    if (total <= 0) throw new Error(`${name} range is empty (after removing board blockers).`);
  }
}

/** Assign combos to equity-percentile buckets (equal total range weight). */
function assignBuckets(
  equity: Float64Array,
  range: Float64Array,
  board: number[],
  numBuckets: number,
): { bucketOf: Int16Array; bucketWeight: Float64Array } {
  const bucketOf = new Int16Array(COMBOS.length).fill(-1);
  const items: { combo: number; eq: number; w: number }[] = [];
  let total = 0;
  for (let i = 0; i < COMBOS.length; i++) {
    const [a, b] = COMBOS[i]!;
    if (board.includes(a) || board.includes(b)) continue;
    const w = range[i]!;
    if (w <= 0) continue;
    items.push({ combo: i, eq: equity[i]!, w });
    total += w;
  }
  items.sort((x, y) => x.eq - y.eq);
  const bucketWeight = new Float64Array(numBuckets);
  let cum = 0;
  for (const it of items) {
    let bIdx = Math.floor((cum / total) * numBuckets);
    if (bIdx >= numBuckets) bIdx = numBuckets - 1;
    bucketOf[it.combo] = bIdx;
    bucketWeight[bIdx] += it.w;
    cum += it.w;
  }
  return { bucketOf, bucketWeight };
}

const _h7 = new Int32Array(7);
const _v7 = new Int32Array(7);

/** Monte Carlo bucket-vs-bucket showdown equity matrix (P0 bucket rows). */
function bucketEquityMatrix(
  cfg: PostflopConfig,
  bucketOf: [Int16Array, Int16Array],
  samplesPerPair: number,
  rng: () => number,
): Float64Array {
  const n = cfg.numBuckets;
  const out = new Float64Array(n * n);
  const boardSet = new Set(cfg.board);
  // combos per bucket per player
  const perBucket: [number[][], number[][]] = [
    Array.from({ length: n }, () => []),
    Array.from({ length: n }, () => []),
  ];
  for (let p = 0 as 0 | 1; p < 2; p = (p + 1) as 0 | 1) {
    for (let i = 0; i < COMBOS.length; i++) {
      const bIdx = bucketOf[p][i]!;
      if (bIdx >= 0) perBucket[p][bIdx]!.push(i);
    }
  }
  const need = 5 - cfg.board.length;
  for (let b0 = 0; b0 < n; b0++) {
    for (let b1 = 0; b1 < n; b1++) {
      const list0 = perBucket[0][b0]!;
      const list1 = perBucket[1][b1]!;
      if (list0.length === 0 || list1.length === 0) {
        out[b0 * n + b1] = 0.5;
        continue;
      }
      let score = 0;
      let used = 0;
      let guard = 0;
      while (used < samplesPerPair && guard++ < samplesPerPair * 30) {
        const c0 = COMBOS[list0[Math.floor(rng() * list0.length)]!]!;
        const c1 = COMBOS[list1[Math.floor(rng() * list1.length)]!]!;
        if (c0[0] === c1[0] || c0[0] === c1[1] || c0[1] === c1[0] || c0[1] === c1[1]) continue;
        // sample runout
        const blocked = new Set<number>([...boardSet, c0[0], c0[1], c1[0], c1[1]]);
        const deck: number[] = [];
        for (let c = 0; c < 52; c++) if (!blocked.has(c)) deck.push(c);
        for (let i = 0; i < cfg.board.length; i++) {
          _h7[i] = cfg.board[i]!;
          _v7[i] = cfg.board[i]!;
        }
        for (let k = 0; k < need; k++) {
          const j = k + Math.floor(rng() * (deck.length - k));
          const tmp = deck[k]!;
          deck[k] = deck[j]!;
          deck[j] = tmp;
          _h7[cfg.board.length + k] = deck[k]!;
          _v7[cfg.board.length + k] = deck[k]!;
        }
        _h7[5] = c0[0];
        _h7[6] = c0[1];
        _v7[5] = c1[0];
        _v7[6] = c1[1];
        const hs = evaluate(_h7);
        const vs = evaluate(_v7);
        score += hs > vs ? 1 : hs === vs ? 0.5 : 0;
        used++;
      }
      out[b0 * n + b1] = used > 0 ? score / used : 0.5;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Betting tree
// ---------------------------------------------------------------------------

interface BetState {
  toAct: 0 | 1;
  inv: [number, number];
  behind: [number, number];
  level: number;
  raises: number;
  pendingLeft: number;
  hist: string;
}

type ActionNext =
  | { t: 'fold' }
  | { t: 'showdown'; s: BetState } // betting closed; s is the FINAL state (call included)
  | { t: 'state'; s: BetState };

interface ActionSpec {
  label: string;
  tag: string;
  next: ActionNext;
}

function bettingActions(cfg: PostflopConfig, s: BetState): ActionSpec[] {
  const p = s.toAct;
  const potNow = cfg.pot + s.inv[0] + s.inv[1];
  const toCall = s.level - s.inv[p]!;
  const behind = s.behind[p]!;
  const maxRaises = cfg.maxRaises ?? 2;
  const acts: ActionSpec[] = [];

  const base = (): BetState => ({
    toAct: (1 - p) as 0 | 1,
    inv: [...s.inv] as [number, number],
    behind: [...s.behind] as [number, number],
    level: s.level,
    raises: s.raises,
    pendingLeft: s.pendingLeft,
    hist: s.hist,
  });

  if (toCall > 0) {
    acts.push({ label: 'Fold', tag: 'f', next: { t: 'fold' } });
    const callAmt = Math.min(toCall, behind);
    const cs = base();
    cs.inv[p] += callAmt;
    cs.behind[p] -= callAmt;
    cs.pendingLeft -= 1;
    cs.hist += 'c';
    acts.push({
      label: callAmt < toCall ? `Call ${callAmt} (all-in)` : 'Call',
      tag: 'c',
      next:
        cs.pendingLeft <= 0 || cs.behind[p] === 0
          ? { t: 'showdown', s: cs }
          : { t: 'state', s: cs },
    });
    // raises
    if (s.raises < maxRaises && behind > toCall) {
      const seen = new Set<number>();
      const addRaise = (targetLevel: number, isAllIn: boolean) => {
        const add = targetLevel - s.inv[p]!;
        if (add <= toCall || seen.has(add)) return;
        seen.add(add);
        const rs = base();
        rs.inv[p] += add;
        rs.behind[p] -= add;
        rs.level = targetLevel;
        rs.raises += 1;
        rs.pendingLeft = 1;
        rs.hist += `r${targetLevel}`;
        acts.push({
          label: isAllIn ? `All-in ${add}` : `Raise to ${targetLevel}`,
          tag: `r${targetLevel}`,
          next: { t: 'state', s: rs },
        });
      };
      for (const f of cfg.betSizes) {
        const raiseBy = Math.max(1, Math.round(f * potNow));
        const target = Math.min(s.level + raiseBy, s.inv[p]! + behind);
        addRaise(target, target >= s.inv[p]! + behind);
      }
      addRaise(s.inv[p]! + behind, true); // explicit all-in
    }
    return acts;
  }

  // No bet to face.
  const checked = base();
  checked.pendingLeft -= 1;
  checked.hist += 'k';
  acts.push({
    label: 'Check',
    tag: 'k',
    next: checked.pendingLeft <= 0 ? { t: 'showdown', s: checked } : { t: 'state', s: checked },
  });
  const seen = new Set<number>();
  const addBet = (amount: number, isAllIn: boolean) => {
    if (amount <= 0 || seen.has(amount)) return;
    seen.add(amount);
    const bs = base();
    bs.inv[p] += amount;
    bs.behind[p] -= amount;
    bs.level = s.inv[p]! + amount;
    bs.raises += 1;
    bs.pendingLeft = 1;
    bs.hist += `b${amount}`;
    acts.push({
      label: isAllIn ? `All-in ${amount}` : `Bet ${amount}`,
      tag: `b${amount}`,
      next: { t: 'state', s: bs },
    });
  };
  for (const f of cfg.betSizes) {
    const amount = Math.min(Math.max(1, Math.round(f * potNow)), behind);
    addBet(amount, amount >= behind);
  }
  addBet(behind, true); // explicit all-in
  return acts;
}

/** Count nodes of one betting subtree (for pre-flight estimates). */
function countBettingNodes(cfg: PostflopConfig, s: BetState): number {
  let count = 1;
  for (const a of bettingActions(cfg, s)) {
    if (a.next.t === 'state') count += countBettingNodes(cfg, a.next.s);
    else count += 1;
  }
  return count;
}

function initialBetState(cfg: PostflopConfig): BetState {
  return {
    toAct: 0,
    inv: [0, 0],
    behind: [cfg.stack, cfg.stack],
    level: 0,
    raises: 0,
    pendingLeft: 2,
    hist: '',
  };
}

/** Pre-flight size estimate for a config (nodes + bytes), without building. */
export function estimatePostflopSize(cfg: PostflopConfig): { nodes: number; bytes: number; pairs: number } {
  const perPair = countBettingNodes(cfg, initialBetState(cfg));
  const pairs = cfg.numBuckets * cfg.numBuckets;
  const nodes = 1 + perPair * pairs;
  const bytes = nodes * BYTES_PER_NODE + nodes * 2 * BYTES_PER_INFOSET_ACTION;
  return { nodes, bytes, pairs };
}

export interface BuiltPostflop {
  tree: GameTree;
  meta: PostflopMeta;
  estimatedBytes: number;
}

export function buildPostflopGame(cfg: PostflopConfig, maxBytes = DEFAULT_MAX_BYTES): BuiltPostflop {
  validateConfig(cfg);
  const est = estimatePostflopSize(cfg);
  if (est.bytes > maxBytes) {
    throw new Error(
      `This spot is too large to solve safely: estimated ${(est.bytes / 1048576).toFixed(0)} MB ` +
        `(~${est.nodes.toLocaleString()} tree nodes) exceeds the ${(maxBytes / 1048576).toFixed(0)} MB budget. ` +
        'Reduce bet-size options, lower the bucket count, or lower the raise cap.',
    );
  }

  const rng = makeRng(cfg.seed ?? 20261023);
  const eqOOP = equityVsRangeAll(cfg.board, cfg.rangeIP, { mcSamples: cfg.mcSamples ?? 300, seed: cfg.seed });
  const eqIP = equityVsRangeAll(cfg.board, cfg.rangeOOP, { mcSamples: cfg.mcSamples ?? 300, seed: (cfg.seed ?? 20261023) + 1 });
  const [bOOP, bIP] = [
    assignBuckets(eqOOP, cfg.rangeOOP, cfg.board, cfg.numBuckets),
    assignBuckets(eqIP, cfg.rangeIP, cfg.board, cfg.numBuckets),
  ];
  const bucketOf: [Int16Array, Int16Array] = [bOOP.bucketOf, bIP.bucketOf];
  const bucketWeight: [Float64Array, Float64Array] = [bOOP.bucketWeight, bIP.bucketWeight];
  const bucketEquity = bucketEquityMatrix(cfg, bucketOf, cfg.bucketEquitySamples ?? 600, rng);

  const meta: PostflopMeta = {
    bucketOf,
    bucketWeight,
    equity: [eqOOP, eqIP],
    bucketEquity,
    infosetKeys: [],
    actionLabels: [],
    numBuckets: cfg.numBuckets,
  };

  const infosetIdByKey = new Map<string, number>();
  const builder = new TreeBuilder(Math.ceil(maxBytes / BYTES_PER_NODE));

  const foldPayoff = (folder: 0 | 1, s: BetState): number => {
    const fp = cfg.pot + s.inv[0] + s.inv[1];
    return folder === 0 ? -s.inv[0]! - cfg.pot / 2 : fp - s.inv[0]! - cfg.pot / 2;
  };
  const showdownPayoff = (b0: number, b1: number, s: BetState): number => {
    const fp = cfg.pot + s.inv[0] + s.inv[1];
    const eq = bucketEquity[b0 * cfg.numBuckets + b1]!;
    return eq * fp - s.inv[0]! - cfg.pot / 2;
  };

  const buildBetting = (s: BetState, b0: number, b1: number): number => {
    const p = s.toAct;
    const bucket = p === 0 ? b0 : b1;
    const key = `P${p}:B${bucket}:${s.hist}`;
    const acts = bettingActions(cfg, s);
    const labels = acts.map((a) => a.label);
    const children = acts.map((a) => {
      if (a.next.t === 'fold') return builder.terminal(foldPayoff(p, s));
      if (a.next.t === 'showdown') return builder.terminal(showdownPayoff(b0, b1, a.next.s));
      return buildBetting(a.next.s, b0, b1);
    });
    // Register in the meta tables at exactly the moment the node is created
    // in the builder, so registry ids match the builder's infoset ids
    // (the builder assigns ids in player()-call order, i.e. post-order).
    if (!infosetIdByKey.has(key)) {
      infosetIdByKey.set(key, meta.infosetKeys.length);
      meta.infosetKeys.push(key);
      meta.actionLabels.push(labels);
    }
    return builder.player(p, key, children);
  };

  // Root chance over bucket pairs, probabilities proportional to bucket
  // range weights (card removal between buckets ignored — see header).
  const pairChildren: number[] = [];
  const pairProbs: number[] = [];
  let wTotal = 0;
  for (let b0 = 0; b0 < cfg.numBuckets; b0++) {
    for (let b1 = 0; b1 < cfg.numBuckets; b1++) {
      const w = bucketWeight[0][b0]! * bucketWeight[1][b1]!;
      if (w <= 0) continue;
      wTotal += w;
      pairProbs.push(w);
      pairChildren.push(buildBetting(initialBetState(cfg), b0, b1));
    }
  }
  for (let i = 0; i < pairProbs.length; i++) pairProbs[i] /= wTotal;
  const root = builder.chance(pairChildren, pairProbs);
  const tree = builder.build(root);

  if (tree.numInfosets !== meta.infosetKeys.length) {
    throw new Error('Internal error: infoset registry out of sync with tree.');
  }
  return { tree, meta, estimatedBytes: tree.estimatedMemoryBytes() };
}

/** Stateful solver session: build once, then step/stop/resume. */
export class PostflopSession {
  readonly cfg: PostflopConfig;
  readonly built: BuiltPostflop;
  private solver: CfrSolver;
  private stopped = false;

  constructor(cfg: PostflopConfig, maxBytes = DEFAULT_MAX_BYTES) {
    this.cfg = cfg;
    this.built = buildPostflopGame(cfg, maxBytes);
    this.solver = new CfrSolver(this.built.tree);
  }

  get iterations(): number {
    return this.solver.iteration;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Run up to `iterations` more iterations or `timeBudgetMs`, whichever first. */
  step(iterations: number, timeBudgetMs = Infinity): number {
    this.stopped = false;
    return this.solver.run(iterations, timeBudgetMs, () => this.stopped);
  }

  result(): PostflopSolution {
    const { tree, meta } = this.built;
    const expl = this.solver.exploitability();
    const infosets: InfosetResult[] = [];
    const rootByBucket: [Map<string, number>[], Map<string, number>[]] = [
      Array.from({ length: this.cfg.numBuckets }, () => new Map<string, number>()),
      Array.from({ length: this.cfg.numBuckets }, () => new Map<string, number>()),
    ];
    const aggregate: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
    const tmp = new Float64Array(64);
    for (let id = 0; id < tree.numInfosets; id++) {
      const key = meta.infosetKeys[id]!;
      const m = /^P([01]):B(\d+):(.*)$/.exec(key)!;
      const player = Number(m[1]) as 0 | 1;
      const bucket = Number(m[2]);
      const history = m[3]!;
      const n = tree.infosetActionCount[id]!;
      const out = new Float64Array(n);
      this.solver.averageStrategyAt(id, out);
      const labels = meta.actionLabels[id]!;
      infosets.push({
        id,
        player,
        bucket,
        history,
        actions: labels.map((label, a) => ({ label, freq: out[a]! })),
      });
      if (history === '') {
        const map = rootByBucket[player][bucket]!;
        labels.forEach((label, a) => map.set(label, out[a]!));
        const w = meta.bucketWeight[player][bucket]!;
        labels.forEach((label, a) => {
          aggregate[player].set(label, (aggregate[player].get(label) ?? 0) + w * out[a]!);
        });
      }
      void tmp;
    }
    // normalize aggregates
    for (const p of [0, 1] as const) {
      let total = 0;
      for (const v of aggregate[p].values()) total += v;
      if (total > 0) for (const [k, v] of aggregate[p]) aggregate[p].set(k, v / total);
    }
    return {
      iterations: this.solver.iteration,
      exploitability: expl.exploitability,
      exploitabilityPctPot: (expl.exploitability / this.cfg.pot) * 100,
      gameValue: this.solver.expectedValue(),
      treeNodes: tree.numNodes,
      numInfosets: tree.numInfosets,
      estimatedBytes: this.built.estimatedBytes,
      infosets,
      aggregate,
      rootByBucket,
      meta,
    };
  }
}

/** Convenience: build and solve in one call. */
export function solvePostflop(cfg: PostflopConfig, opts: SolveOptions = {}): PostflopSolution {
  const session = new PostflopSession(cfg, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  const reportEvery = 200;
  let remaining = opts.iterations ?? 1000;
  while (remaining > 0) {
    const chunk = Math.min(reportEvery, remaining);
    session.step(chunk, opts.timeBudgetMs);
    remaining -= chunk;
    if (opts.onProgress) {
      let pct: number | null = null;
      if (session.iterations % 1000 < reportEvery) {
        pct = session.result().exploitabilityPctPot;
      }
      opts.onProgress(session.iterations, pct);
    }
    if (opts.shouldStop?.()) break;
    if (opts.timeBudgetMs !== undefined && opts.timeBudgetMs <= 0) break;
  }
  return session.result();
}
