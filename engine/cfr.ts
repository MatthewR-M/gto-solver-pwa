// Generic extensive-form game tree + CFR+ solver with a best-response
// exploitability calculator. Payoffs are stored as player 0's utility;
// player 1's utility is the negation (two-player zero-sum).
//
// The tree is built explicitly into typed arrays. Builders construct nodes
// bottom-up (children first). Infosets are registered by string key together
// with their action count; every node in an infoset must have the same
// number of actions.

export const NT_CHANCE = 0;
export const NT_PLAYER = 1;
export const NT_TERMINAL = 2;

/** Rough bytes per tree node across all arrays (used for pre-flight estimates). */
export const BYTES_PER_NODE = 48;
/** Rough bytes per infoset action (regret + strategy sum, Float64 x2 + overhead). */
export const BYTES_PER_INFOSET_ACTION = 24;

export class GameTree {
  type!: Uint8Array;
  player!: Int8Array; // acting player at player nodes
  infoset!: Int32Array; // infoset id at player nodes
  childOffset!: Int32Array;
  childCount!: Int32Array;
  children!: Int32Array;
  childProb!: Float64Array; // chance probability per child slot
  payoff!: Float64Array; // terminal: player 0 utility
  numNodes = 0;
  // infoset tables
  infosetPlayer!: Int8Array;
  infosetActionOffset!: Int32Array;
  infosetActionCount!: Int32Array;
  numInfosets = 0;
  totalActions = 0;

  root = 0;

  estimatedMemoryBytes(): number {
    return this.numNodes * BYTES_PER_NODE + this.totalActions * BYTES_PER_INFOSET_ACTION;
  }
}

export class TreeBuilder {
  private _type: number[] = [];
  private _player: number[] = [];
  private _infoset: number[] = [];
  private _childOffset: number[] = [];
  private _childCount: number[] = [];
  private _payoff: number[] = [];
  private _children: number[] = [];
  private _childProb: number[] = [];
  private _infosetIds = new Map<string, number>();
  private _infosetPlayer: number[] = [];
  private _infosetActionOffset: number[] = [];
  private _infosetActionCount: number[] = [];
  private _totalActions = 0;
  readonly maxNodes: number;

  constructor(maxNodes = 40_000_000) {
    this.maxNodes = maxNodes;
  }

  get nodeCount(): number {
    return this._type.length;
  }

  private pushNode(type: number): number {
    if (this._type.length >= this.maxNodes) {
      throw new Error(
        `Game tree exceeds the size limit (${this.maxNodes.toLocaleString()} nodes). ` +
          'Reduce the bet-size options, lower the bucket count, or narrow the ranges.',
      );
    }
    this._type.push(type);
    this._player.push(-1);
    this._infoset.push(-1);
    this._childOffset.push(0);
    this._childCount.push(0);
    this._payoff.push(0);
    return this._type.length - 1;
  }

  terminal(payoffP0: number): number {
    const id = this.pushNode(NT_TERMINAL);
    this._payoff[id] = payoffP0;
    return id;
  }

  chance(children: number[], probs: number[]): number {
    const id = this.pushNode(NT_CHANCE);
    this._childOffset[id] = this._children.length;
    this._childCount[id] = children.length;
    for (let i = 0; i < children.length; i++) {
      this._children.push(children[i]!);
      this._childProb.push(probs[i]!);
    }
    return id;
  }

  player(player: 0 | 1, infosetKey: string, children: number[]): number {
    const id = this.pushNode(NT_PLAYER);
    let isid = this._infosetIds.get(infosetKey);
    if (isid === undefined) {
      isid = this._infosetPlayer.length;
      this._infosetIds.set(infosetKey, isid);
      this._infosetPlayer.push(player);
      this._infosetActionOffset.push(this._totalActions);
      this._infosetActionCount.push(children.length);
      this._totalActions += children.length;
    } else if (this._infosetActionCount[isid] !== children.length) {
      throw new Error(
        `Infoset "${infosetKey}" has inconsistent action counts ` +
          `(${this._infosetActionCount[isid]} vs ${children.length}).`,
      );
    }
    this._player[id] = player;
    this._infoset[id] = isid;
    this._childOffset[id] = this._children.length;
    this._childCount[id] = children.length;
    for (let i = 0; i < children.length; i++) {
      this._children.push(children[i]!);
      this._childProb.push(0);
    }
    return id;
  }

  build(root: number): GameTree {
    const t = new GameTree();
    t.type = Uint8Array.from(this._type);
    t.player = Int8Array.from(this._player);
    t.infoset = Int32Array.from(this._infoset);
    t.childOffset = Int32Array.from(this._childOffset);
    t.childCount = Int32Array.from(this._childCount);
    t.payoff = Float64Array.from(this._payoff);
    t.children = Int32Array.from(this._children);
    t.childProb = Float64Array.from(this._childProb);
    t.numNodes = this._type.length;
    t.infosetPlayer = Int8Array.from(this._infosetPlayer);
    t.infosetActionOffset = Int32Array.from(this._infosetActionOffset);
    t.infosetActionCount = Int32Array.from(this._infosetActionCount);
    t.numInfosets = this._infosetPlayer.length;
    t.totalActions = this._totalActions;
    t.root = root;
    return t;
  }
}

export class CfrSolver {
  readonly tree: GameTree;
  private regret: Float64Array;
  private stratSum: Float64Array;
  private strat: Float64Array; // scratch current strategy per action slot
  iteration = 0;

  constructor(tree: GameTree) {
    this.tree = tree;
    this.regret = new Float64Array(tree.totalActions);
    this.stratSum = new Float64Array(tree.totalActions);
    this.strat = new Float64Array(tree.totalActions);
  }

  /** Current (regret-matching+) strategy for an infoset, written into `out`. */
  strategyAt(infoset: number, out: Float64Array): void {
    const off = this.tree.infosetActionOffset[infoset]!;
    const n = this.tree.infosetActionCount[infoset]!;
    let sum = 0;
    for (let a = 0; a < n; a++) {
      const r = this.regret[off + a]!;
      const v = r > 0 ? r : 0;
      this.strat[off + a] = v;
      sum += v;
    }
    for (let a = 0; a < n; a++) {
      out[a] = sum > 0 ? this.strat[off + a]! / sum : 1 / n;
    }
  }

  /** Time-averaged strategy for an infoset (the solver's output), into `out`. */
  averageStrategyAt(infoset: number, out: Float64Array): void {
    const off = this.tree.infosetActionOffset[infoset]!;
    const n = this.tree.infosetActionCount[infoset]!;
    let sum = 0;
    for (let a = 0; a < n; a++) sum += this.stratSum[off + a]!;
    for (let a = 0; a < n; a++) {
      out[a] = sum > 0 ? this.stratSum[off + a]! / sum : 1 / n;
    }
  }

  averageStrategyArray(): Float64Array {
    const out = new Float64Array(this.tree.totalActions);
    const tmp: number[] = [];
    for (let i = 0; i < this.tree.numInfosets; i++) {
      const off = this.tree.infosetActionOffset[i]!;
      const n = this.tree.infosetActionCount[i]!;
      tmp.length = n;
      this.averageStrategyAt(i, tmp as unknown as Float64Array);
      for (let a = 0; a < n; a++) out[off + a] = tmp[a]!;
    }
    return out;
  }

  /**
   * Run CFR+ iterations (alternating updates, linear strategy averaging).
   * Stops early if `timeBudgetMs` is exceeded (checked between iterations)
   * or if `shouldStop()` returns true. Returns iterations completed.
   */
  run(maxIterations: number, timeBudgetMs = Infinity, shouldStop: () => boolean = () => false): number {
    const start = Date.now();
    let done = 0;
    while (done < maxIterations) {
      const updater: 0 | 1 = this.iteration % 2 === 0 ? 0 : 1;
      this.cfr(this.tree.root, 1, 1, updater, this.iteration + 1);
      this.iteration++;
      done++;
      if ((done & 7) === 0) {
        if (Date.now() - start > timeBudgetMs || shouldStop()) break;
      }
    }
    return done;
  }

  private cfr(node: number, reach0: number, reach1: number, updater: 0 | 1, weight: number): number {
    const t = this.tree;
    const type = t.type[node]!;
    if (type === NT_TERMINAL) return t.payoff[node]!;
    const off = t.childOffset[node]!;
    const n = t.childCount[node]!;
    if (type === NT_CHANCE) {
      let ev = 0;
      for (let a = 0; a < n; a++) {
        ev += t.childProb[off + a]! * this.cfr(t.children[off + a]!, reach0, reach1, updater, weight);
      }
      return ev;
    }
    const player = t.player[node]! as 0 | 1;
    const isid = t.infoset[node]!;
    // Local copy of the current strategy: recursive calls must not be able
    // to clobber it while this node still needs it.
    const sigma = new Float64Array(n);
    this.strategyAt(isid, sigma);
    const ioff = t.infosetActionOffset[isid]!;

    if (player !== updater) {
      let ev = 0;
      for (let a = 0; a < n; a++) {
        const p = sigma[a]!;
        if (p <= 0) continue;
        ev +=
          p *
          this.cfr(
            t.children[off + a]!,
            player === 0 ? reach0 * p : reach0,
            player === 1 ? reach1 * p : reach1,
            updater,
            weight,
          );
      }
      return ev;
    }

    // Updating player: compute action values, then CFR+ regret update.
    const actionValues = new Float64Array(n);
    let ev = 0;
    const myReach = player === 0 ? reach0 : reach1;
    const oppReach = player === 0 ? reach1 : reach0;
    for (let a = 0; a < n; a++) {
      const p = sigma[a]!;
      // accumulate average strategy proportional to own reach (linear weighting)
      this.stratSum[ioff + a] += weight * myReach * p;
      const v = this.cfr(
        t.children[off + a]!,
        player === 0 ? reach0 * p : reach0,
        player === 1 ? reach1 * p : reach1,
        updater,
        weight,
      );
      actionValues[a] = v;
      ev += p * v;
    }
    const sign = player === 0 ? 1 : -1; // payoffs are P0 utility
    for (let a = 0; a < n; a++) {
      const r = sign * (actionValues[a]! - ev) * oppReach;
      const nv = this.regret[ioff + a]! + r;
      this.regret[ioff + a] = nv > 0 ? nv : 0; // CFR+ floor at 0
    }
    return ev;
  }

  /** Expected payoff for player 0 under the average strategy profile. */
  expectedValue(): number {
    const avg = this.averageStrategyArray();
    return this.evalProfile(this.tree.root, avg);
  }

  private evalProfile(node: number, strat: Float64Array): number {
    const t = this.tree;
    const type = t.type[node]!;
    if (type === NT_TERMINAL) return t.payoff[node]!;
    const off = t.childOffset[node]!;
    const n = t.childCount[node]!;
    let ev = 0;
    if (type === NT_CHANCE) {
      for (let a = 0; a < n; a++) {
        ev += t.childProb[off + a]! * this.evalProfile(t.children[off + a]!, strat);
      }
      return ev;
    }
    const ioff = t.infosetActionOffset[t.infoset[node]!]!;
    for (let a = 0; a < n; a++) {
      const p = strat[ioff + a]!;
      if (p <= 0) continue;
      ev += p * this.evalProfile(t.children[off + a]!, strat);
    }
    return ev;
  }

  /**
   * Best-response values against the average strategy, computed exactly:
   * a forward pass computes counterfactual reach (chance x opponent
   * strategy) for every node; then infoset action values are aggregated
   * across all nodes of each infoset of the best-responding player and the
   * best action is chosen per infoset (deepest infosets resolve first via
   * recursion). Returns { br0, br1, exploitability } with br_i in player
   * i's own utility and exploitability = (br0 + br1) / 2 >= 0, equal to 0
   * only at an exact equilibrium of the game represented by the tree.
   */
  exploitability(): { br0: number; br1: number; exploitability: number } {
    const avg = this.averageStrategyArray();
    const br0 = this.exactBestResponse(0, avg);
    const br1 = -this.exactBestResponse(1, avg);
    return { br0, br1, exploitability: (br0 + br1) / 2 };
  }

  /** Best-response value (in player 0's utility) for `brPlayer` vs `strat`. */
  exactBestResponse(brPlayer: 0 | 1, strat: Float64Array): number {
    const t = this.tree;
    // Nodes per infoset.
    const nodesOfInfoset: number[][] = Array.from({ length: t.numInfosets }, () => []);
    for (let nd = 0; nd < t.numNodes; nd++) {
      if (t.type[nd] === NT_PLAYER) nodesOfInfoset[t.infoset[nd]!]!.push(nd);
    }
    // Forward pass: counterfactual reach (chance and opponent strategy only;
    // the BR player's own actions do not discount reach).
    const reach = new Float64Array(t.numNodes);
    reach[t.root] = 1;
    for (let nd = t.numNodes - 1; nd >= 0; nd--) {
      const r = reach[nd]!;
      if (r === 0) continue;
      const type = t.type[nd]!;
      if (type === NT_TERMINAL) continue;
      const off = t.childOffset[nd]!;
      const n = t.childCount[nd]!;
      if (type === NT_CHANCE) {
        for (let a = 0; a < n; a++) reach[t.children[off + a]!] += r * t.childProb[off + a]!;
      } else if (t.player[nd] === brPlayer) {
        for (let a = 0; a < n; a++) reach[t.children[off + a]!] += r;
      } else {
        const ioff = t.infosetActionOffset[t.infoset[nd]!]!;
        for (let a = 0; a < n; a++) reach[t.children[off + a]!] += r * strat[ioff + a]!;
      }
    }
    const memo = new Float64Array(t.numNodes);
    const done = new Uint8Array(t.numNodes);
    const chosenAction = new Int32Array(t.numInfosets).fill(-1);

    const nodeValue = (node: number): number => {
      if (done[node]) return memo[node]!;
      const type = t.type[node]!;
      let v: number;
      if (type === NT_TERMINAL) {
        v = t.payoff[node]!;
      } else {
        const off = t.childOffset[node]!;
        const n = t.childCount[node]!;
        if (type === NT_CHANCE) {
          v = 0;
          for (let a = 0; a < n; a++) v += t.childProb[off + a]! * nodeValue(t.children[off + a]!);
        } else if (t.player[node] !== brPlayer) {
          const ioff = t.infosetActionOffset[t.infoset[node]!]!;
          v = 0;
          for (let a = 0; a < n; a++) {
            const p = strat[ioff + a]!;
            if (p > 0) v += p * nodeValue(t.children[off + a]!);
          }
        } else {
          const isid = t.infoset[node]!;
          if (chosenAction[isid] < 0) {
            // Aggregate counterfactual action values across the infoset.
            const cnt = t.infosetActionCount[isid]!;
            let bestA = 0;
            let bestQ = brPlayer === 0 ? -Infinity : Infinity;
            for (let a = 0; a < cnt; a++) {
              let q = 0;
              for (const nd of nodesOfInfoset[isid]!) {
                if (reach[nd] === 0) continue;
                q += reach[nd]! * nodeValue(t.children[t.childOffset[nd]! + a]!);
              }
              if (brPlayer === 0 ? q > bestQ : q < bestQ) {
                bestQ = q;
                bestA = a;
              }
            }
            chosenAction[isid] = bestA;
          }
          v = nodeValue(t.children[off + chosenAction[isid]!]!);
        }
      }
      memo[node] = v;
      done[node] = 1;
      return v;
    };

    return nodeValue(t.root);
  }
}
