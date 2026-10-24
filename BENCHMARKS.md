# Benchmarks

Measured 2026-10-24T00:10:57.061Z on the build sandbox:
- Node v24.22.1, linux x64
- CPU: Intel(R) Xeon(R) Platinum 8321HC CPU @ 1.40GHz (2 cores)

**These are desktop/server Node numbers, NOT iPhone numbers.** No
measurement on a real iPhone has been made; iOS Safari runs this code
in a different JIT with different thermal limits. Treat the iPhone
figures as unknown until measured on device.

## Hand evaluator
- 1.97M evaluations/sec (pre-generated random 7-card hands; an earlier run of this harness that generated a random hand per call measured 0.55M/sec, which was mostly RNG/Set overhead)

## Equity
- Full-range flop equity (1326 combos x 300 MC samples): 749 ms

## CFR throughput
- Kuhn (55 nodes): 166,434.991 iterations/sec
- Leduc (9,451 nodes, 288 infosets): 940 iterations/sec; after 1000 iterations exploitability 0.0713 chips

## Postflop spot solve (reduced tree)
- Spot: Qs Js 8d flop, full ranges both sides, pot 100, stack 300,
  bet sizes 33%/75% pot + all-in, max 2 raises, 10 equity buckets
- Tree: 5,701 nodes, 200 infosets, estimated 0.3 MB; build (equities + tree) 1137 ms
- Node heap after build: 13 MB (includes runtime overhead)
- After ~10s of solving (29,500 iterations): exploitability 0.38% of pot (abstract game)
- After ~30s of solving (88,500 iterations): exploitability 0.22% of pot (abstract game)
- After ~60s of solving (177,000 iterations): exploitability 0.16% of pot (abstract game)

The stated target was <= 2% of pot in ~60s on a recent iPhone-class
device for a reduced-tree flop solve. On this sandbox CPU the target
is met with large margin; whether it holds on a real iPhone is
UNVERIFIED (no device available). The same abstraction on a slower
JIT should be expected to land several times slower.
