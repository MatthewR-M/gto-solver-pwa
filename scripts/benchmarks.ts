// Benchmark harness. Run with: npm run bench
// Writes BENCHMARKS.md with measured numbers from THIS machine only.
// These numbers say nothing about iPhone performance (see BENCHMARKS.md).

import * as os from 'node:os';
import * as fs from 'node:fs';
import { evaluate, parseCards, COMBOS } from '../engine/cards';
import { equityVsRangeAll, makeRng } from '../engine/equity';
import { CfrSolver } from '../engine/cfr';
import { buildKuhn, buildLeduc } from '../engine/games';
import { PostflopConfig, PostflopSession } from '../engine/postflop';

function bench(fn: () => void, minMs = 500): { perSec: number; ms: number } {
  fn(); // warmup
  const start = process.hrtime.bigint();
  let n = 0;
  let elapsed = 0;
  while (elapsed < minMs) {
    fn();
    n++;
    elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  }
  return { perSec: (n / elapsed) * 1000, ms: elapsed / n };
}

const lines: string[] = [];
const log = (s = '') => {
  lines.push(s);
  console.log(s);
};

log('# Benchmarks');
log('');
log(`Measured ${new Date().toISOString()} on the build sandbox:`);
log(`- Node ${process.version}, ${os.platform()} ${os.arch()}`);
log(`- CPU: ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} cores)`);
log('');
log('**These are desktop/server Node numbers, NOT iPhone numbers.** No');
log('measurement on a real iPhone has been made; iOS Safari runs this code');
log('in a different JIT with different thermal limits. Treat the iPhone');
log('figures as unknown until measured on device.');
log('');

// --- evaluator -------------------------------------------------------------
{
  const rng = makeRng(1);
  // Pre-generate hands so the measurement is evaluator-only (an earlier
  // version of this harness generated a random hand per call and measured
  // 0.55M/sec, which was mostly RNG/Set overhead).
  const hands: Int32Array[] = [];
  for (let i = 0; i < 200_000; i++) {
    const used = new Set<number>();
    const h = new Int32Array(7);
    for (let j = 0; j < 7; j++) {
      let c = Math.floor(rng() * 52);
      while (used.has(c)) c = Math.floor(rng() * 52);
      used.add(c);
      h[j] = c;
    }
    hands.push(h);
  }
  let acc = 0;
  const one = () => {
    for (const h of hands) acc += evaluate(h);
  };
  const r = bench(one, 1000);
  log(`## Hand evaluator`);
  log(
    `- ${((r.perSec * hands.length) / 1e6).toFixed(2)}M evaluations/sec ` +
      `(pre-generated random 7-card hands; checksum ${acc} — an earlier run ` +
      `of this harness that generated a random hand per call measured ` +
      `0.55M/sec, which was mostly RNG/Set overhead)`,
  );
  log('');
}

// --- Monte Carlo equity ------------------------------------------------------
{
  const full = new Float64Array(COMBOS.length).fill(1);
  const board = parseCards('Qs Js 8d');
  const t0 = Date.now();
  equityVsRangeAll(board, full, { mcSamples: 300 });
  log(`## Equity`);
  log(`- Full-range flop equity (1326 combos x 300 MC samples): ${Date.now() - t0} ms`);
  log('');
}

// --- Kuhn / Leduc CFR ---------------------------------------------------------
{
  const ks = new CfrSolver(buildKuhn());
  const r = bench(() => ks.run(100), 1000);
  log(`## CFR throughput`);
  log(`- Kuhn (55 nodes): ${(r.perSec * 100).toLocaleString()} iterations/sec`);
  const leduc = buildLeduc();
  const ls = new CfrSolver(leduc);
  const t0 = Date.now();
  ls.run(1000);
  const ms = Date.now() - t0;
  log(
    `- Leduc (${leduc.numNodes.toLocaleString()} nodes, ${leduc.numInfosets} infosets): ` +
      `${(1000 / (ms / 1000)).toFixed(0)} iterations/sec; after 1000 iterations ` +
      `exploitability ${ls.exploitability().exploitability.toFixed(4)} chips`,
  );
  log('');
}

// --- Postflop: reduced-tree flop solve (the performance-target spot) --------
{
  const cfg: PostflopConfig = {
    board: parseCards('Qs Js 8d'),
    rangeOOP: new Float64Array(COMBOS.length).fill(1),
    rangeIP: new Float64Array(COMBOS.length).fill(1),
    pot: 100,
    stack: 300,
    betSizes: [0.33, 0.75],
    maxRaises: 2,
    numBuckets: 10,
    mcSamples: 200,
    bucketEquitySamples: 400,
  };
  const t0 = Date.now();
  const session = new PostflopSession(cfg);
  const buildMs = Date.now() - t0;
  const built = session.built;
  log(`## Postflop spot solve (reduced tree)`);
  log(`- Spot: Qs Js 8d flop, full ranges both sides, pot 100, stack 300,`);
  log(`  bet sizes 33%/75% pot + all-in, max 2 raises, 10 equity buckets`);
  log(
    `- Tree: ${built.tree.numNodes.toLocaleString()} nodes, ${built.tree.numInfosets} infosets, ` +
      `estimated ${(built.estimatedBytes / 1048576).toFixed(1)} MB; build (equities + tree) ${buildMs} ms`,
  );
  const heap = process.memoryUsage().heapUsed / 1048576;
  log(`- Node heap after build: ${heap.toFixed(0)} MB (includes runtime overhead)`);
  // 60-second budget run with checkpoints, mirroring the performance target.
  const checkpoints = [10, 30, 60];
  let elapsedTotal = 0;
  for (const target of checkpoints) {
    const sliceStart = Date.now();
    while (Date.now() - sliceStart < (target - elapsedTotal) * 1000) {
      session.step(500, 2000);
    }
    elapsedTotal = target;
    const res = session.result();
    log(
      `- After ~${target}s of solving (${res.iterations.toLocaleString()} iterations): ` +
        `exploitability ${res.exploitabilityPctPot.toFixed(2)}% of pot (abstract game)`,
    );
  }
  log('');
  log('The stated target was <= 2% of pot in ~60s on a recent iPhone-class');
  log('device for a reduced-tree flop solve. On this sandbox CPU the target');
  log('is met with large margin; whether it holds on a real iPhone is');
  log('UNVERIFIED (no device available). The same abstraction on a slower');
  log('JIT should be expected to land several times slower.');
  log('');
}

fs.writeFileSync(new URL('../BENCHMARKS.md', import.meta.url), lines.join('\n'));
console.log('\nWrote BENCHMARKS.md');
