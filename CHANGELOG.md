# Changelog

## 0.1.0 — 2026-10-23

Initial build.

- Engine: packed-integer 7-card evaluator; exact/Monte Carlo equity; CFR+
  with exact best-response exploitability; validated on Kuhn (value −1/18),
  Leduc, and an analytic river toy game (closed-form match).
- Postflop solver: equity-percentile bucket abstraction, single-street
  betting trees with configurable sizes and raise caps, pre-flight memory
  estimate with oversized-tree refusal, stop/resume sessions.
- App: Spot Solver, Quick Advisor (instant preflop chart lookup + fast
  postflop solve), Preflop Charts viewer. Solver runs in a Web Worker.
- Preflop charts generated from first principles (Monte Carlo equities +
  documented heuristic thresholds) at 50/100/200bb.
- PWA: full precache, versioned service worker with update banner,
  persistent-storage request, generated icons, iPhone install support.
- CI: lint, tests, build on push/PR; deploy to GitHub Pages from main.
