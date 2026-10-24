import { useEffect, useMemo, useRef, useState } from 'react';
import { COMBOS, NUM_COMBOS, classIndexOf, className } from '../../engine/cards';
import { CardPicker, CardsDisplay } from '../components/CardPicker';
import { RangeGrid } from '../components/RangeGrid';
import {
  POSITIONS,
  PREFLOP,
  classWeights,
  rangeShare,
  removeBlockers,
  toggleClass,
  topPercentRange,
  weightsFromClassFreq,
  weightsFromClassWeights,
} from '../lib/ranges';
import { deleteSpot, listSpots, saveSpot, type SavedSpot } from '../lib/savedSpots';
import type { SerializedSolution, WorkerResponse } from '../worker/solver.worker';

const BET_SIZE_OPTIONS = [0.33, 0.5, 0.75, 1.0, 1.5];
const ACTION_COLORS: Record<string, string> = {
  Check: '120,200,120',
  Call: '100,160,255',
  Fold: '150,150,150',
};
function actionColor(label: string): string {
  if (ACTION_COLORS[label]) return ACTION_COLORS[label]!;
  if (label.startsWith('Bet')) return '255,90,90';
  if (label.startsWith('Raise')) return '255,60,160';
  if (label.startsWith('All-in')) return '255,170,40';
  return '200,200,120';
}

type Status = 'idle' | 'running' | 'done' | 'error';

export function SolverScreen() {
  const [board, setBoard] = useState<number[]>([]);
  const [ranges, setRanges] = useState<[Float64Array, Float64Array]>(() => [
    topPercentRange(25),
    topPercentRange(25),
  ]);
  const [editPlayer, setEditPlayer] = useState<0 | 1>(0);
  const [pot, setPot] = useState(100);
  const [stack, setStack] = useState(300);
  const [betSizes, setBetSizes] = useState<number[]>([0.33, 0.75]);
  const [maxRaises, setMaxRaises] = useState(2);
  const [numBuckets, setNumBuckets] = useState(10);
  const [iterations, setIterations] = useState(5000);
  const [timeBudgetSec, setTimeBudgetSec] = useState(30);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ iterations: number; pct: number | null }>({
    iterations: 0,
    pct: null,
  });
  const [solution, setSolution] = useState<SerializedSolution | null>(null);
  const [solvedRanges, setSolvedRanges] = useState<[Float64Array, Float64Array] | null>(null);

  const [viewPlayer, setViewPlayer] = useState<0 | 1>(0);
  const [viewHistory, setViewHistory] = useState('');
  const [viewAction, setViewAction] = useState<string>('Check');
  const [selectedClass, setSelectedClass] = useState<number | null>(null);
  const [spotName, setSpotName] = useState('');
  const [saved, setSaved] = useState<SavedSpot[]>([]);

  const refreshSaved = () => {
    listSpots()
      .then((spots) => setSaved(spots.sort((a, b) => b.createdAt - a.createdAt)))
      .catch(() => setSaved([]));
  };
  useEffect(refreshSaved, []);

  const saveCurrentSpot = async () => {
    const name = spotName.trim() || `Spot ${new Date().toLocaleString()}`;
    await saveSpot({
      name,
      createdAt: Date.now(),
      board,
      pot,
      stack,
      betSizes,
      maxRaises,
      numBuckets,
      rangeOOPClasses: Array.from(classWeights(ranges[0])),
      rangeIPClasses: Array.from(classWeights(ranges[1])),
      summary: solution
        ? {
            exploitabilityPctPot: solution.exploitabilityPctPot,
            gameValue: solution.gameValue,
            iterations: solution.iterations,
            aggregateOOP: solution.aggregate[0],
          }
        : null,
    });
    setSpotName('');
    refreshSaved();
  };

  const loadSpot = (spot: SavedSpot) => {
    setBoard(spot.board);
    setPot(spot.pot);
    setStack(spot.stack);
    setBetSizes(spot.betSizes);
    setMaxRaises(spot.maxRaises);
    setNumBuckets(spot.numBuckets);
    setRanges([
      weightsFromClassWeights(spot.rangeOOPClasses),
      weightsFromClassWeights(spot.rangeIPClasses),
    ]);
    setSolution(null);
    setStatus('idle');
    window.scrollTo({ top: 0 });
  };

  const workerRef = useRef<Worker | null>(null);
  useEffect(() => {
    const w = new Worker(new URL('../worker/solver.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress({ iterations: msg.iterations, pct: msg.exploitabilityPctPot });
      } else if (msg.type === 'result') {
        setSolution(msg.solution);
        setStatus('done');
        setViewHistory('');
        setViewPlayer(0);
      } else if (msg.type === 'error') {
        setError(msg.message);
        setStatus('error');
      }
    };
    workerRef.current = w;
    return () => w.terminate();
  }, []);

  const stratMap = useMemo(() => {
    const map = new Map<string, { label: string; freq: number }[]>();
    if (solution) {
      for (const is of solution.infosets) {
        map.set(`${is.player}|${is.bucket}|${is.history}`, is.actions);
      }
    }
    return map;
  }, [solution]);

  const historiesForPlayer = useMemo(() => {
    if (!solution) return [] as string[];
    const set = new Set<string>();
    for (const is of solution.infosets) if (is.player === viewPlayer) set.add(is.history);
    return Array.from(set).sort();
  }, [solution, viewPlayer]);

  const actionsAtView = useMemo(() => {
    if (!solution) return [] as string[];
    for (let b = 0; b < solution.numBuckets; b++) {
      const acts = stratMap.get(`${viewPlayer}|${b}|${viewHistory}`);
      if (acts) return acts.map((a) => a.label);
    }
    return [] as string[];
  }, [solution, stratMap, viewPlayer, viewHistory]);

  useEffect(() => {
    if (actionsAtView.length > 0 && !actionsAtView.includes(viewAction)) {
      setViewAction(actionsAtView[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsAtView]);

  const gridValues = useMemo(() => {
    const out = new Float64Array(169);
    if (!solution || !solvedRanges) return out;
    const range = solvedRanges[viewPlayer];
    const perClassSum = new Float64Array(169);
    const perClassW = new Float64Array(169);
    for (let i = 0; i < NUM_COMBOS; i++) {
      const wgt = range[i]!;
      if (wgt <= 0) continue;
      const [a, b] = COMBOS[i]!;
      const bucket = solution.bucketOf[viewPlayer][i]!;
      if (bucket < 0) continue;
      const acts = stratMap.get(`${viewPlayer}|${bucket}|${viewHistory}`);
      if (!acts) continue;
      const f = acts.find((x) => x.label === viewAction)?.freq ?? 0;
      const classIdx = classIndexOf(a, b);
      perClassSum[classIdx] += wgt * f;
      perClassW[classIdx] += wgt;
    }
    for (let ci = 0; ci < 169; ci++) {
      out[ci] = perClassW[ci]! > 0 ? perClassSum[ci]! / perClassW[ci]! : 0;
    }
    return out;
  }, [solution, solvedRanges, viewPlayer, viewHistory, viewAction, stratMap]);

  function startSolve(cont: boolean) {
    const w = workerRef.current;
    if (!w) return;
    setError(null);
    if (cont) {
      setStatus('running');
      w.postMessage({ type: 'continue', iterations, timeBudgetMs: timeBudgetSec * 1000 });
      return;
    }
    if (board.length < 3) {
      setError('Pick at least the 3 flop cards.');
      setStatus('error');
      return;
    }
    const cleanOOP = removeBlockers(ranges[0], board);
    const cleanIP = removeBlockers(ranges[1], board);
    if (rangeShare(cleanOOP) <= 0 || rangeShare(cleanIP) <= 0) {
      setError('Both ranges need at least one hand that does not conflict with the board.');
      setStatus('error');
      return;
    }
    setSolvedRanges([cleanOOP, cleanIP]);
    setSolution(null);
    setStatus('running');
    setProgress({ iterations: 0, pct: null });
    w.postMessage({
      type: 'start',
      config: {
        board,
        rangeOOP: Array.from(cleanOOP),
        rangeIP: Array.from(cleanIP),
        pot,
        stack,
        betSizes,
        maxRaises,
        numBuckets,
      },
      iterations,
      timeBudgetMs: timeBudgetSec * 1000,
    });
  }

  const stopSolve = () => workerRef.current?.postMessage({ type: 'stop' });

  const applyPreset = (kind: string, posA: string, posB: string) => {
    const next: [Float64Array, Float64Array] = [ranges[0], ranges[1]];
    if (kind === 'all') next[editPlayer] = new Float64Array(NUM_COMBOS).fill(1);
    else if (kind === 'clear') next[editPlayer] = new Float64Array(NUM_COMBOS);
    else if (kind === 'rfi') {
      next[editPlayer] = weightsFromClassFreq(PREFLOP.rfi['100']?.[posA] ?? {});
    } else if (kind === 'vsopen') {
      const entry = PREFLOP.vsOpen['100']?.[posA]?.[posB];
      const merged: Record<string, number> = { ...(entry?.call ?? {}) };
      for (const [k, v] of Object.entries(entry?.threeBet ?? {})) merged[k] = v;
      next[editPlayer] = weightsFromClassFreq(merged);
    }
    setRanges(next);
  };

  const detail = useMemo(() => {
    if (selectedClass === null || !solution || !solvedRanges) return null;
    const range = solvedRanges[viewPlayer];
    let eqSum = 0;
    let wSum = 0;
    const buckets = new Set<number>();
    for (let i = 0; i < NUM_COMBOS; i++) {
      const [a, b] = COMBOS[i]!;
      if (classIndexOf(a, b) !== selectedClass) continue;
      const wgt = range[i]!;
      if (wgt <= 0) continue;
      eqSum += wgt * (solution.equity[viewPlayer][i] ?? 0);
      wSum += wgt;
      const bk = solution.bucketOf[viewPlayer][i]!;
      if (bk >= 0) buckets.add(bk);
    }
    const bucket = buckets.size === 1 ? Array.from(buckets)[0]! : null;
    const acts =
      bucket !== null ? stratMap.get(`${viewPlayer}|${bucket}|${viewHistory}`) : undefined;
    return {
      name: className(selectedClass),
      equity: wSum > 0 ? eqSum / wSum : null,
      bucket,
      acts,
    };
  }, [selectedClass, solution, solvedRanges, viewPlayer, viewHistory, stratMap]);

  return (
    <div className="screen">
      <section className="panel">
        <h2>Spot setup</h2>
        <label className="field-label">
          Board ({board.length}/5) — tap cards to set the flop, then turn/river
        </label>
        <CardPicker selected={board} max={5} onChange={setBoard} />
        <div className="row wrap gap">
          <span>
            Board: <CardsDisplay cards={board} />
          </span>
          {board.length >= 3 && (
            <button type="button" className="btn small" onClick={() => setBoard(board.slice(0, 3))}>
              Flop only
            </button>
          )}
          {board.length > 0 && (
            <button type="button" className="btn small" onClick={() => setBoard([])}>
              Clear board
            </button>
          )}
        </div>

        <div className="row gap">
          <label className="num-field">
            Pot
            <input type="number" value={pot} min={1} onChange={(e) => setPot(Number(e.target.value))} />
          </label>
          <label className="num-field">
            Stack behind
            <input
              type="number"
              value={stack}
              min={1}
              onChange={(e) => setStack(Number(e.target.value))}
            />
          </label>
          <label className="num-field">
            Buckets
            <select value={numBuckets} onChange={(e) => setNumBuckets(Number(e.target.value))}>
              {[6, 8, 10, 12, 16, 20, 40].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="num-field">
            Max raises
            <select value={maxRaises} onChange={(e) => setMaxRaises(Number(e.target.value))}>
              {[1, 2, 3].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field-label">Bet sizes (% of pot, all-in always included)</label>
        <div className="row wrap gap">
          {BET_SIZE_OPTIONS.map((f) => (
            <button
              key={f}
              type="button"
              className={`btn toggle${betSizes.includes(f) ? ' on' : ''}`}
              onClick={() =>
                setBetSizes(betSizes.includes(f) ? betSizes.filter((x) => x !== f) : [...betSizes, f].sort())
              }
            >
              {Math.round(f * 100)}%
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Ranges</h2>
        <div className="row gap">
          <button
            type="button"
            className={`btn toggle${editPlayer === 0 ? ' on' : ''}`}
            onClick={() => setEditPlayer(0)}
          >
            OOP range ({(rangeShare(removeBlockers(ranges[0], board)) * 100).toFixed(0)}%)
          </button>
          <button
            type="button"
            className={`btn toggle${editPlayer === 1 ? ' on' : ''}`}
            onClick={() => setEditPlayer(1)}
          >
            IP range ({(rangeShare(removeBlockers(ranges[1], board)) * 100).toFixed(0)}%)
          </button>
        </div>
        <p className="muted">
          OOP acts first on this street (e.g. the big blind in a single-raised pot); IP acts last.
          Tap classes in the grid to add/remove them.
        </p>
        <RangeEditor
          key={editPlayer}
          initial={ranges[editPlayer]}
          onApply={(w) => {
            const next: [Float64Array, Float64Array] = [ranges[0], ranges[1]];
            next[editPlayer] = w;
            setRanges(next);
          }}
          applyPreset={applyPreset}
        />
      </section>

      <section className="panel">
        <h2>Solve</h2>
        <div className="row gap">
          <label className="num-field">
            Iterations
            <input
              type="number"
              value={iterations}
              min={100}
              step={500}
              onChange={(e) => setIterations(Number(e.target.value))}
            />
          </label>
          <label className="num-field">
            Time budget (s)
            <input
              type="number"
              value={timeBudgetSec}
              min={1}
              onChange={(e) => setTimeBudgetSec(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="row gap">
          {status !== 'running' ? (
            <button type="button" className="btn primary" onClick={() => startSolve(false)}>
              Solve
            </button>
          ) : (
            <button type="button" className="btn danger" onClick={stopSolve}>
              Stop
            </button>
          )}
          {status === 'done' && (
            <button type="button" className="btn" onClick={() => startSolve(true)}>
              Continue solving
            </button>
          )}
        </div>
        {status === 'running' && (
          <p>
            Solving… {progress.iterations.toLocaleString()} iterations
            {progress.pct !== null && (
              <>
                {' '}
                · exploitability ≈ {progress.pct.toFixed(2)}% of pot (abstract game)
              </>
            )}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <p className="muted">
          Model: one street of betting with configurable sizes; later streets collapse into
          showdown equity (perfect equity realization). Hands are grouped into equity-percentile
          buckets — a hand's strategy is its bucket's strategy. Exploitability is exact for this
          abstract game and is a lower bound for the full game.
        </p>
      </section>

      {solution && (
        <section className="panel">
          <h2>Results</h2>
          <div className="stats-grid">
            <div>
              <span className="stat-label">Exploitability</span>
              <strong>{solution.exploitabilityPctPot.toFixed(2)}% of pot</strong>
              <span className="muted"> (abstract game)</span>
            </div>
            <div>
              <span className="stat-label">OOP EV</span>
              <strong>{solution.gameValue.toFixed(1)} chips</strong>
              <span className="muted"> (vs owning half the pot)</span>
            </div>
            <div>
              <span className="stat-label">Iterations</span>
              <strong>{solution.iterations.toLocaleString()}</strong>
            </div>
            <div>
              <span className="stat-label">Tree</span>
              <strong>
                {solution.treeNodes.toLocaleString()} nodes · {solution.numInfosets} infosets
              </strong>
            </div>
            <div>
              <span className="stat-label">Est. memory</span>
              <strong>{(solution.estimatedBytes / 1048576).toFixed(1)} MB</strong>
            </div>
          </div>

          <h3>Range aggregate (first decision)</h3>
          <div className="row wrap gap">
            <div className="agg-box">
              <strong>OOP</strong>
              {(solution.aggregate[0].length ? solution.aggregate[0] : []).map(([label, f]) => (
                <div key={label} className="freq-row">
                  <span>{label}</span>
                  <span className="freq-bar">
                    <span
                      className="freq-fill"
                      style={{ width: `${f * 100}%`, background: `rgb(${actionColor(label)})` }}
                    />
                  </span>
                  <span>{(f * 100).toFixed(1)}%</span>
                </div>
              ))}
            </div>
            <div className="agg-box">
              <strong>IP (after OOP checks)</strong>
              {(() => {
                const agg = new Map<string, number>();
                let totalW = 0;
                for (const is of solution.infosets) {
                  if (is.player !== 1 || is.history !== 'k') continue;
                  const w = solution.bucketWeight[1][is.bucket] ?? 0;
                  totalW += w;
                  for (const a of is.actions) {
                    agg.set(a.label, (agg.get(a.label) ?? 0) + w * a.freq);
                  }
                }
                if (totalW === 0) return <div className="muted">OOP never checks.</div>;
                return Array.from(agg.entries()).map(([label, f]) => {
                  const frac = f / totalW;
                  return (
                    <div key={label} className="freq-row">
                      <span>{label}</span>
                      <span className="freq-bar">
                        <span
                          className="freq-fill"
                          style={{
                            width: `${frac * 100}%`,
                            background: `rgb(${actionColor(label)})`,
                          }}
                        />
                      </span>
                      <span>{(frac * 100).toFixed(1)}%</span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          <h3>Strategy grid</h3>
          <div className="row wrap gap">
            <label className="num-field">
              Player
              <select value={viewPlayer} onChange={(e) => setViewPlayer(Number(e.target.value) as 0 | 1)}>
                <option value={0}>OOP</option>
                <option value={1}>IP</option>
              </select>
            </label>
            <label className="num-field">
              History
              <select value={viewHistory} onChange={(e) => setViewHistory(e.target.value)}>
                {historiesForPlayer.map((h) => (
                  <option key={h} value={h}>
                    {h === '' ? '(first to act)' : h}
                  </option>
                ))}
              </select>
            </label>
            <label className="num-field">
              Action
              <select value={viewAction} onChange={(e) => setViewAction(e.target.value)}>
                {actionsAtView.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">
            History codes: k = check, b&lt;n&gt; = bet n, c = call, r&lt;n&gt; = raise to n. Cell
            shading = frequency of the chosen action. Tap a class for detail.
          </p>
          <RangeGrid
            values={gridValues}
            color={actionColor(viewAction)}
            selectedClass={selectedClass ?? undefined}
            onSelect={setSelectedClass}
          />
          {detail && (
            <div className="detail-box">
              <strong>{detail.name}</strong>
              {detail.equity !== null && (
                <span>
                  {' '}
                  · equity vs opposing range {(detail.equity * 100).toFixed(1)}%
                </span>
              )}
              {detail.bucket !== null && <span> · bucket {detail.bucket}</span>}
              {detail.acts && (
                <div>
                  {detail.acts.map((a) => (
                    <div key={a.label} className="freq-row">
                      <span>{a.label}</span>
                      <span className="freq-bar">
                        <span
                          className="freq-fill"
                          style={{
                            width: `${a.freq * 100}%`,
                            background: `rgb(${actionColor(a.label)})`,
                          }}
                        />
                      </span>
                      <span>{(a.freq * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              )}
              {detail.bucket === null && (
                <p className="muted">This class spans multiple buckets; frequencies vary by exact combo/suits.</p>
              )}
            </div>
          )}
        </section>
      )}
      <section className="panel">
        <h2>Saved spots (on this device)</h2>
        <div className="row gap">
          <label className="num-field">
            Spot name
            <input
              type="text"
              value={spotName}
              placeholder="e.g. QJs flop, BB vs BTN"
              onChange={(e) => setSpotName(e.target.value)}
            />
          </label>
          <button type="button" className="btn" onClick={saveCurrentSpot}>
            Save current setup{solution ? ' + result' : ''}
          </button>
        </div>
        {saved.length === 0 && <p className="muted">No saved spots yet.</p>}
        {saved.map((spot) => (
          <div key={spot.id} className="agg-box" style={{ marginBottom: 8 }}>
            <strong>{spot.name}</strong>
            <span className="muted">
              {' '}
              · {new Date(spot.createdAt).toLocaleDateString()} · pot {spot.pot}, stack {spot.stack},{' '}
              {spot.numBuckets} buckets
            </span>
            {spot.summary && (
              <div className="muted">
                Result: exploitability {spot.summary.exploitabilityPctPot.toFixed(2)}% of pot · OOP
                EV {spot.summary.gameValue.toFixed(1)} · {spot.summary.iterations.toLocaleString()}{' '}
                iterations · OOP first action:{' '}
                {spot.summary.aggregateOOP
                  .filter(([, f]) => f > 0.01)
                  .map(([l, f]) => `${l} ${(f * 100).toFixed(0)}%`)
                  .join(', ')}
              </div>
            )}
            <div className="row gap">
              <button type="button" className="btn small" onClick={() => loadSpot(spot)}>
                Load setup
              </button>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  if (spot.id !== undefined) {
                    void deleteSpot(spot.id).then(refreshSaved);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        <p className="muted">
          Spots are stored locally in IndexedDB and never leave the device. iOS may evict site data
          for long-unused apps despite the persistent-storage request.
        </p>
      </section>
    </div>
  );
}

// Range editor with presets; keeps its own working copy.
function RangeEditor({
  initial,
  onApply,
  applyPreset,
}: {
  initial: Float64Array;
  onApply: (w: Float64Array) => void;
  applyPreset: (kind: string, posA: string, posB: string) => void;
}) {
  const [topPct, setTopPct] = useState(25);
  const [kind, setKind] = useState('top');
  const [posA, setPosA] = useState('BTN');
  const [posB, setPosB] = useState('BB');
  const values = useMemo(() => classWeights(initial), [initial]);
  return (
    <div>
      <RangeGrid
        values={values}
        color="80,180,255"
        onSelect={(ci) => onApply(toggleClass(initial, ci))}
      />
      <div className="row wrap gap">
        <label className="num-field">
          Preset
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="top">Top % by equity</option>
            <option value="rfi">Chart: RFI range</option>
            <option value="vsopen">Chart: vs-open continue</option>
            <option value="all">All hands</option>
            <option value="clear">Empty</option>
          </select>
        </label>
        {kind === 'top' && (
          <label className="num-field">
            Top %
            <input
              type="number"
              value={topPct}
              min={1}
              max={100}
              onChange={(e) => setTopPct(Number(e.target.value))}
            />
          </label>
        )}
        {(kind === 'rfi' || kind === 'vsopen') && (
          <label className="num-field">
            {kind === 'rfi' ? 'Position' : 'Opener'}
            <select value={posA} onChange={(e) => setPosA(e.target.value)}>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === 'vsopen' && (
          <label className="num-field">
            Responder
            <select value={posB} onChange={(e) => setPosB(e.target.value)}>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (kind === 'top') onApply(topPercentRange(topPct));
            else applyPreset(kind, posA, posB);
          }}
        >
          Apply preset
        </button>
      </div>
      <p className="muted">
        Current range: {(rangeShare(initial) * 100).toFixed(1)}% of all starting hands (before
        board blockers).
      </p>
    </div>
  );
}

