// Solver Web Worker: owns a PostflopSession and runs CFR in chunks so the
// UI stays responsive and can stop/resume. All messages are plain JSON.

import { PostflopSession, PostflopConfig, PostflopSolution } from '../../engine/postflop';

export interface SolveRequest {
  type: 'start';
  config: {
    board: number[];
    rangeOOP: number[];
    rangeIP: number[];
    pot: number;
    stack: number;
    betSizes: number[];
    maxRaises: number;
    numBuckets: number;
  };
  iterations: number;
  timeBudgetMs: number;
}
export interface ContinueRequest {
  type: 'continue';
  iterations: number;
  timeBudgetMs: number;
}
export interface StopRequest {
  type: 'stop';
}
export type WorkerRequest = SolveRequest | ContinueRequest | StopRequest;

export interface SerializedSolution {
  iterations: number;
  exploitability: number;
  exploitabilityPctPot: number;
  gameValue: number;
  treeNodes: number;
  numInfosets: number;
  estimatedBytes: number;
  infosets: PostflopSolution['infosets'];
  aggregate: [Array<[string, number]>, Array<[string, number]>];
  rootByBucket: [Array<Array<[string, number]>>, Array<Array<[string, number]>>];
  bucketOf: [number[], number[]];
  equity: [number[], number[]];
  bucketWeight: [number[], number[]];
  numBuckets: number;
}

export type WorkerResponse =
  | { type: 'progress'; iterations: number; exploitabilityPctPot: number | null }
  | { type: 'result'; solution: SerializedSolution }
  | { type: 'error'; message: string };

let session: PostflopSession | null = null;
let stopRequested = false;
let running = false;

function serialize(sol: PostflopSolution): SerializedSolution {
  return {
    iterations: sol.iterations,
    exploitability: sol.exploitability,
    exploitabilityPctPot: sol.exploitabilityPctPot,
    gameValue: sol.gameValue,
    treeNodes: sol.treeNodes,
    numInfosets: sol.numInfosets,
    estimatedBytes: sol.estimatedBytes,
    infosets: sol.infosets,
    aggregate: [Array.from(sol.aggregate[0].entries()), Array.from(sol.aggregate[1].entries())],
    rootByBucket: [
      sol.rootByBucket[0].map((m) => Array.from(m.entries())),
      sol.rootByBucket[1].map((m) => Array.from(m.entries())),
    ],
    bucketOf: [Array.from(sol.meta.bucketOf[0]), Array.from(sol.meta.bucketOf[1])],
    equity: [Array.from(sol.meta.equity[0]), Array.from(sol.meta.equity[1])],
    bucketWeight: [Array.from(sol.meta.bucketWeight[0]), Array.from(sol.meta.bucketWeight[1])],
    numBuckets: sol.meta.numBuckets,
  };
}

function post(msg: WorkerResponse): void {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
}

function runChunks(iterations: number, timeBudgetMs: number): void {
  if (!session || running) return;
  running = true;
  stopRequested = false;
  const deadline = Date.now() + timeBudgetMs;
  let remaining = iterations;
  const tick = () => {
    if (!session) {
      running = false;
      return;
    }
    if (stopRequested || remaining <= 0 || Date.now() >= deadline) {
      running = false;
      try {
        post({ type: 'result', solution: serialize(session.result()) });
      } catch (err) {
        post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const chunk = Math.min(200, remaining);
    const done = session.step(chunk, 750);
    remaining -= done;
    let pct: number | null = null;
    if (session.iterations % 1000 < 200) {
      try {
        pct = session.result().exploitabilityPctPot;
      } catch {
        pct = null;
      }
    }
    post({ type: 'progress', iterations: session.iterations, exploitabilityPctPot: pct });
    setTimeout(tick, 0);
  };
  tick();
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'start') {
      stopRequested = true;
      const cfg: PostflopConfig = {
        board: msg.config.board,
        rangeOOP: Float64Array.from(msg.config.rangeOOP),
        rangeIP: Float64Array.from(msg.config.rangeIP),
        pot: msg.config.pot,
        stack: msg.config.stack,
        betSizes: msg.config.betSizes,
        maxRaises: msg.config.maxRaises,
        numBuckets: msg.config.numBuckets,
      };
      session = new PostflopSession(cfg);
      post({ type: 'progress', iterations: 0, exploitabilityPctPot: null });
      runChunks(msg.iterations, msg.timeBudgetMs);
    } else if (msg.type === 'continue') {
      if (!session) {
        post({ type: 'error', message: 'No solve session to continue. Start a solve first.' });
        return;
      }
      runChunks(msg.iterations, msg.timeBudgetMs);
    } else if (msg.type === 'stop') {
      stopRequested = true;
      session?.stop();
    }
  } catch (err) {
    running = false;
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
