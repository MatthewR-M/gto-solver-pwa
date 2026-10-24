# Project Report — GTO Solver PWA

Date: 2026-10-23. Repo: `gto-solver-pwa` (public, GitHub Pages). All work is
committed locally in small milestone commits; nothing has been pushed (the
parent agent handles GitHub).

## What was built

- **Engine** (`engine/`, pure TypeScript, typed arrays, no DOM):
  - Packed-integer 7-card hand evaluator (~1.97M evals/sec in Node here).
  - Equity: exact enumeration on river/turn; seeded Monte Carlo elsewhere.
  - CFR+ solver over an explicit game tree (alternating updates, linear
    averaging) with an **exact best-response exploitability** calculator.
  - Postflop game: equity-percentile **card buckets** (configurable count),
    **single-street betting tree** (configurable pot-fraction sizes + all-in,
    raise cap), bucket-vs-bucket Monte Carlo showdown equity matrix for the
    remaining runout, pre-flight memory estimate that **refuses oversized
    trees** with a clear message, stop/resume sessions.
- **Validation games**: Kuhn poker, Leduc Hold'em, and an analytic river
  toy game with a derived closed-form solution.
- **Preflop charts** (`scripts/generate-preflop.ts` → `src/data/preflop.json`,
  23 KB): Monte Carlo equities from the project's own evaluator plus
  documented heuristic thresholds (RFI targets, 3-bet/call/4-bet equity
  cutoffs, suited bluff 3-bets). Open / vs-open / 3-bet / 4-bet by position
  at 50/100/200bb. No proprietary data used.
- **App** (React 18 + Vite): Spot Solver (board picker, editable 13×13
  ranges with presets, abstraction controls, worker-based solve with
  progress + stop/continue, per-class strategy grid, aggregates, EV/equity,
  exploitability readout), Quick Advisor (instant preflop chart lookup;
  postflop fast solve at 6 buckets), Charts viewer, and — as the stretch
  item — **saved spots in IndexedDB** with result summaries for review.
- **PWA**: vite-plugin-pwa precache (12 entries, ~237 KiB: shell, worker,
  icons, bundled chart data), prompt-style update banner, persistent
  storage request, generated icons (programmatic PNG spade), iOS meta
  tags, safe-area insets, ≥44px primary controls, layout from 375px.
- **CI** (`.github/workflows/ci.yml`): lint + test + build on push/PR;
  build + `actions/deploy-pages` on main.

## Test results (actual, `npm test`, this sandbox)

10/10 tests pass (suite ~38–96 s depending on CPU contention; the
evaluator enumeration dominates):

- Evaluator: all **133,784,560** seven-card hands enumerated; category
  counts match the known combinatorial values **exactly** (e.g. straight
  flush 41,584; quads 224,848; full house 3,473,184; one pair 58,627,800).
- Equity: Monte Carlo vs exact turn enumeration agree within **0.01**
  (measured 0.8463 vs 0.8451 at 20k samples).
- Kuhn: game value **−0.05598** vs known **−1/18 = −0.05556** after 2,000
  iterations in smoke runs; the test (20,000 iterations) asserts value
  within 0.002 and exploitability < 0.002 — passes.
- Leduc: exploitability **0.0713** after 1,000 iterations, **0.0385**
  after 5,000 (test asserts decreasing and < 0.05) — passes.
- River toy: CFR matches the derived closed form (bluff **1/3**, call
  **2/3**, value bet ~100%, game value **50/3 ≈ 16.667**; measured value
  16.667, frequencies within 0.003 in smoke runs) — passes. (An initial
  version of this test caught a real payoff-accounting error — the
  bettor's own bet coming back in the pot — which was fixed and
  re-derived.)
- Postflop: AA vs a mixed flop range bets half-pot **99.6%** (a
  dominating-hand regression that caught a payoff bug during development:
  showdown-after-call terminals once used pre-call investments);
  oversized-tree refusal fires; results deterministic per seed;
  stop/resume equals continuous solving.
- Offline behavior (Playwright, production build served locally,
  offline browser context): **PASSED, all 5 checks** — app loads online;
  service worker controls the page; app reloads fully offline; the
  preflop chart grid renders offline (169 cells); the advisor screen
  renders offline. A second browser run drove the real UI end-to-end
  (set As Kd 7c, Solve, 200 iterations) and produced a results panel
  with aggregates (Check 63.1% / Bet 33 24.2% / Bet 75 7.7% / All-in
  5.0%; exploitability 6.59% of pot at just 200 iterations). Caveat:
  Playwright's own Chromium downloads repeatedly failed to persist in
  this sandbox's browser cache, so the runs used the sandbox's
  pre-provisioned headless-shell Chromium binary via the script's
  `PW_EXECUTABLE_PATH` override. The test itself (`scripts/offline-
  test.mjs`) is environment-agnostic.

## Benchmarks (sandbox only — NOT iPhone)

From `BENCHMARKS.md` (Node v24.22.1, sandbox Linux x86-64):

- Evaluator: **1.97M evals/sec**.
- Full-range flop equity for all 1,326 combos (300 MC samples): **0.75 s**.
- CFR throughput: Kuhn ~166k iters/sec; Leduc ~940 iters/sec.
- Reduced flop spot (Qs Js 8d, full ranges, pot 100, stack 300, 33%/75%
  + all-in, ≤2 raises, 10 buckets; tree 5,701 nodes / 200 infosets /
  ~0.3 MB): exploitability **0.38% of pot after ~10 s**, **0.22% after
  30 s**, **0.16% after 60 s** (abstract game). The ≤2%-in-60s target is
  met on this CPU with wide margin.
- **iPhone performance is UNVERIFIED** — no device was available. Expect
  a phone JIT to be several times slower; the abstraction knobs (buckets,
  bet sizes, raises) are exposed precisely so the spot can be shrunk to
  fit.

## Known limitations and approximations

1. **The solver output is NOT full-game GTO.** It is the exact-ish
   solution of an abstract game: equity buckets, one street of betting,
   future streets collapsed into showdown equity (perfect equity
   realization assumed), and bucket-level card removal between players
   ignored. Abstract-game exploitability is a lower bound for the real
   thing. All of this is labeled in the UI and README.
2. **Preflop charts are a heuristic equity model**, not solver output;
   thresholds are documented in the generator and README.
3. Single effective stack for both players; starting pot treated as
   contributed equally; bet amounts rounded to whole chips.
4. Quick Advisor postflop uses a generic top-40% hero range and 6
   buckets; it took ~1–3 s in desktop testing (the <200 ms target applies
   to the preflop lookup path, which is instant). Not measured on iPhone.
5. Saved spots store class-level ranges (exact for this app's editor,
   which works at class granularity) and result summaries, not full
   solver state; re-solving is required to inspect a spot again.
6. No real-device testing: layout, install flow, SW behavior, and
   performance on iOS Safari are unverified. A manual airplane-mode
   checklist is in the README. (Offline behavior itself IS verified in
   a desktop Chromium via Playwright — see the test results above.)
7. GitHub Pages deploy is configured but has never run (no push yet);
   the repo also needs the one-time Settings → Pages → Source: GitHub
   Actions step described in the README.

## Bugs caught by the validation process (for the record)

- Shared scratch array in CFR corrupted strategies mid-recursion (fixed:
  per-node local strategy copy). Kuhn convergence exposed it.
- River toy payoffs initially not zero-sum (bettor's returned bet
  miscounted); re-derived the closed form (call frequency is 2/3, value
  50/3) and fixed the tree.
- Postflop showdown-after-call terminals used pre-call investments;
  caught by the polarized-AA regression spot.
- Preflop generator divided MC equity by requested samples instead of
  completed samples, biasing sparse-range equities down; fixed and
  regenerated (UTG then correctly 4-bets AA/KK/QQ vs a BTN 3-bet).

## Project tree (abridged)

```
engine/            cards.ts equity.ts cfr.ts games.ts postflop.ts index.ts
src/               App.tsx main.tsx pwa.ts index.css
  screens/         SolverScreen.tsx AdvisorScreen.tsx ChartsScreen.tsx
  components/      CardPicker.tsx RangeGrid.tsx
  lib/             ranges.ts savedSpots.ts
  worker/          solver.worker.ts
  data/            preflop.json (generated, committed)
tests/             evaluator.test.ts equity.test.ts cfr.test.ts postflop.test.ts
scripts/           generate-preflop.ts benchmarks.ts generate-icons.mjs offline-test.mjs
.github/workflows/ ci.yml
BENCHMARKS.md  README.md  CHANGELOG.md  REPORT.md
```

## Exact commands for Matthew (PowerShell)

```powershell
# first time only: create the empty public repo "gto-solver-pwa" on github.com,
# then in the project folder:
git remote add origin https://github.com/<your-username>/gto-solver-pwa.git
git push -u origin main
# then in repo Settings -> Pages -> Build and deployment -> Source: GitHub Actions

# local development
npm install
npm run dev
npm test
npm run build
```
