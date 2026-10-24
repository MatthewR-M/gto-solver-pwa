import { useEffect, useMemo, useRef, useState } from 'react';
import { COMBOS, comboIndex, classIndexOf, className } from '../../engine/cards';
import { CardPicker, CardsDisplay } from '../components/CardPicker';
import {
  POSITIONS,
  PREFLOP,
  removeBlockers,
  topPercentRange,
} from '../lib/ranges';
import type { SerializedSolution, WorkerResponse } from '../worker/solver.worker';

type Depth = '50' | '100' | '200';

interface Advice {
  title: string;
  lines: string[];
  mix?: { label: string; freq: number }[];
  source: string;
  elapsedMs?: number;
}

export function AdvisorScreen() {
  const [hero, setHero] = useState<number[]>([]);
  const [board, setBoard] = useState<number[]>([]);
  const [heroPos, setHeroPos] = useState('BTN');
  const [depth, setDepth] = useState<Depth>('100');
  const [situation, setSituation] = useState<'rfi' | 'vsOpen' | 'vs3bet'>('rfi');
  const [opener, setOpener] = useState('CO');
  const [threeBettor, setThreeBettor] = useState('BB');
  // postflop
  const [heroSeat, setHeroSeat] = useState<'OOP' | 'IP'>('IP');
  const [pot, setPot] = useState(100);
  const [stack, setStack] = useState(300);
  const [villainPct, setVillainPct] = useState(40);
  const [villainAction, setVillainAction] = useState<'check' | 'bet'>('check');
  const [villainBetPct, setVillainBetPct] = useState(75);
  const [advice, setAdvice] = useState<Advice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const pendingRef = useRef<{ heroCombo: number; startedAt: number } | null>(null);

  useEffect(() => {
    const w = new Worker(new URL('../worker/solver.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'result' && pendingRef.current) {
        const { heroCombo, startedAt } = pendingRef.current;
        pendingRef.current = null;
        setBusy(false);
        setAdvice(postflopAdvice(msg.solution, heroCombo, startedAt));
      } else if (msg.type === 'error') {
        pendingRef.current = null;
        setBusy(false);
        setError(msg.message);
      }
    };
    workerRef.current = w;
    return () => w.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const heroClass = useMemo(() => {
    if (hero.length !== 2) return null;
    return className(classIndexOf(hero[0]!, hero[1]!));
  }, [hero]);

  const preflopAdvice = (): Advice | null => {
    if (!heroClass) return null;
    const eq = PREFLOP.equityVsRandom[heroClass];
    const base = `Your hand ${heroClass} has ${(eq * 100).toFixed(0)}% all-in equity vs a random hand (Monte Carlo).`;
    if (situation === 'rfi') {
      const f = PREFLOP.rfi[depth]?.[heroPos]?.[heroClass] ?? 0;
      return {
        title: f > 0 ? `Open-raise ${heroClass} from ${heroPos}` : `Fold ${heroClass} from ${heroPos}`,
        lines: [
          base,
          f > 0
            ? `The ${depth}bb chart opens this hand${f < 1 ? ` at ${(f * 100).toFixed(0)}% frequency` : ''} from ${heroPos}.`
            : `The ${depth}bb chart does not open this hand from ${heroPos}; opening ranges tighten in early position.`,
        ],
        mix: [
          { label: 'Raise', freq: f },
          { label: 'Fold', freq: 1 - f },
        ],
        source: 'Precomputed heuristic chart (equity model — not a solver output). Instant lookup.',
      };
    }
    if (situation === 'vsOpen') {
      const entry = PREFLOP.vsOpen[depth]?.[opener]?.[heroPos];
      const tb = entry?.threeBet[heroClass] ?? 0;
      const call = entry?.call[heroClass] ?? 0;
      const fold = Math.max(0, 1 - tb - call);
      const best = tb >= call && tb >= fold ? '3-bet' : call >= fold ? 'Call' : 'Fold';
      return {
        title: `${best} with ${heroClass} vs a ${opener} open`,
        lines: [
          base,
          `Chart mix vs a ${opener} open at ${depth}bb: 3-bet ${(tb * 100).toFixed(0)}%, call ${(call * 100).toFixed(0)}%, fold ${(fold * 100).toFixed(0)}%.`,
        ],
        mix: [
          { label: '3-bet', freq: tb },
          { label: 'Call', freq: call },
          { label: 'Fold', freq: fold },
        ],
        source: 'Precomputed heuristic chart (equity model — not a solver output). Instant lookup.',
      };
    }
    const entry = PREFLOP.vs3bet[depth]?.[heroPos]?.[threeBettor];
    const fb = entry?.fourBet[heroClass] ?? 0;
    const call = entry?.call[heroClass] ?? 0;
    const fold = Math.max(0, 1 - fb - call);
    const best = fb >= call && fb >= fold ? '4-bet' : call >= fold ? 'Call' : 'Fold';
    return {
      title: `${best} with ${heroClass} vs a ${threeBettor} 3-bet`,
      lines: [
        base,
        `You opened from ${heroPos} and face a 3-bet from ${threeBettor} at ${depth}bb. Chart mix: 4-bet ${(fb * 100).toFixed(0)}%, call ${(call * 100).toFixed(0)}%, fold ${(fold * 100).toFixed(0)}%.`,
      ],
      mix: [
        { label: '4-bet', freq: fb },
        { label: 'Call', freq: call },
        { label: 'Fold', freq: fold },
      ],
      source: 'Precomputed heuristic chart (equity model — not a solver output). Instant lookup.',
    };
  };

  const runPostflop = () => {
    const w = workerRef.current;
    if (!w || hero.length !== 2 || board.length < 3) return;
    setError(null);
    setAdvice(null);
    setBusy(true);
    const heroPlayer = heroSeat === 'OOP' ? 0 : 1;
    const villainPlayer = (1 - heroPlayer) as 0 | 1;
    const heroRange = removeBlockers(topPercentRange(40), [...board, ...hero]);
    const villainRange = removeBlockers(topPercentRange(villainPct), [...board, ...hero]);
    const ranges: [Float64Array, Float64Array] = [new Float64Array(COMBOS.length), new Float64Array(COMBOS.length)];
    ranges[heroPlayer] = heroRange;
    ranges[villainPlayer] = villainRange;
    pendingRef.current = {
      heroCombo: comboIndex(hero[0]!, hero[1]!),
      startedAt: Date.now(),
    };
    w.postMessage({
      type: 'start',
      config: {
        board,
        rangeOOP: Array.from(ranges[0]),
        rangeIP: Array.from(ranges[1]),
        pot,
        stack,
        betSizes: [0.33, 0.75],
        maxRaises: 1,
        numBuckets: 6,
      },
      iterations: 600,
      timeBudgetMs: 15000,
    });
  };

  const postflopAdvice = (sol: SerializedSolution, heroCombo: number, startedAt: number): Advice => {
    const heroPlayer = heroSeat === 'OOP' ? 0 : 1;
    const bucket = sol.bucketOf[heroPlayer][heroCombo]!;
    const equity = sol.equity[heroPlayer][heroCombo]!;
    // Pick the infoset matching the described line.
    let history = '';
    if (heroPlayer === 1) {
      if (villainAction === 'check') history = 'k';
      else if (villainAction === 'bet') {
        const target = Math.max(1, Math.round((villainBetPct / 100) * pot));
        let bestHist = '';
        let bestDiff = Infinity;
        for (const is of sol.infosets) {
          if (is.player !== 1) continue;
          const m = /^b(\d+)$/.exec(is.history);
          if (m) {
            const d = Math.abs(Number(m[1]) - target);
            if (d < bestDiff) {
              bestDiff = d;
              bestHist = is.history;
            }
          }
        }
        history = bestHist;
      }
    }
    const infoset = sol.infosets.find(
      (i) => i.player === heroPlayer && i.bucket === bucket && i.history === history,
    );
    const mix = infoset?.actions ?? [];
    const top = [...mix].sort((a, b) => b.freq - a.freq)[0];
    const lines = [
      `Your hand's equity vs the villain's top-${villainPct}% range on this board is ${(equity * 100).toFixed(0)}% (exact on turn/river, Monte Carlo on the flop).`,
      `In the quick solve it falls in bucket ${bucket} of ${sol.numBuckets} (hands grouped by equity). The bucket's mix at this decision is the recommendation — nearby hands play the same way in this abstraction.`,
      `Solve quality: exploitability ${sol.exploitabilityPctPot.toFixed(2)}% of pot in the abstract game after ${sol.iterations.toLocaleString()} iterations. One street only; later streets are folded into equity.`,
    ];
    return {
      title: top ? `${top.label} (${(top.freq * 100).toFixed(0)}%)` : 'No recommendation',
      lines,
      mix,
      source: 'Fast abstracted solve (6 buckets, one street). Not the precomputed path.',
      elapsedMs: Date.now() - startedAt,
    };
  };

  const pfAdvice = situation && board.length < 3 ? preflopAdvice() : null;

  return (
    <div className="screen">
      <section className="panel">
        <h2>Your hand</h2>
        <CardPicker selected={hero} max={2} onChange={setHero} disabledCards={board} />
        <p>
          Hand: <CardsDisplay cards={hero} /> {heroClass && <strong>({heroClass})</strong>}
        </p>
        <label className="field-label">Board (leave empty for a preflop question)</label>
        <CardPicker selected={board} max={5} onChange={setBoard} disabledCards={hero} />
        <p>
          Board: <CardsDisplay cards={board} />
        </p>
      </section>

      {board.length < 3 ? (
        <section className="panel">
          <h2>Preflop advisor (chart lookup)</h2>
          <div className="row wrap gap">
            <label className="num-field">
              Your position
              <select value={heroPos} onChange={(e) => setHeroPos(e.target.value)}>
                {POSITIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="num-field">
              Stack depth
              <select value={depth} onChange={(e) => setDepth(e.target.value as Depth)}>
                <option value="50">50bb</option>
                <option value="100">100bb</option>
                <option value="200">200bb</option>
              </select>
            </label>
            <label className="num-field">
              Situation
              <select value={situation} onChange={(e) => setSituation(e.target.value as typeof situation)}>
                <option value="rfi">First in (open or fold)</option>
                <option value="vsOpen">Facing an open</option>
                <option value="vs3bet">Facing a 3-bet after opening</option>
              </select>
            </label>
            {situation === 'vsOpen' && (
              <label className="num-field">
                Opener
                <select value={opener} onChange={(e) => setOpener(e.target.value)}>
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {situation === 'vs3bet' && (
              <label className="num-field">
                3-bettor
                <select value={threeBettor} onChange={(e) => setThreeBettor(e.target.value)}>
                  {POSITIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {pfAdvice ? <AdviceView advice={pfAdvice} /> : <p className="muted">Pick your two cards.</p>}
        </section>
      ) : (
        <section className="panel">
          <h2>Postflop advisor (fast solve)</h2>
          <div className="row wrap gap">
            <label className="num-field">
              You are
              <select value={heroSeat} onChange={(e) => setHeroSeat(e.target.value as 'OOP' | 'IP')}>
                <option value="OOP">Out of position</option>
                <option value="IP">In position</option>
              </select>
            </label>
            <label className="num-field">
              Pot
              <input type="number" value={pot} min={1} onChange={(e) => setPot(Number(e.target.value))} />
            </label>
            <label className="num-field">
              Stack behind
              <input type="number" value={stack} min={1} onChange={(e) => setStack(Number(e.target.value))} />
            </label>
            <label className="num-field">
              Villain range (top %)
              <input
                type="number"
                value={villainPct}
                min={5}
                max={100}
                onChange={(e) => setVillainPct(Number(e.target.value))}
              />
            </label>
            {heroSeat === 'IP' && (
              <>
                <label className="num-field">
                  Villain action
                  <select value={villainAction} onChange={(e) => setVillainAction(e.target.value as typeof villainAction)}>
                    <option value="check">Checked to you</option>
                    <option value="bet">Bet into you</option>
                  </select>
                </label>
                {villainAction === 'bet' && (
                  <label className="num-field">
                    Bet size (% pot)
                    <input
                      type="number"
                      value={villainBetPct}
                      min={5}
                      max={300}
                      onChange={(e) => setVillainBetPct(Number(e.target.value))}
                    />
                  </label>
                )}
              </>
            )}
          </div>
          <button type="button" className="btn primary" disabled={busy || hero.length !== 2} onClick={runPostflop}>
            {busy ? 'Solving…' : 'Get recommendation'}
          </button>
          {error && <p className="error">{error}</p>}
          {advice && <AdviceView advice={advice} />}
          <p className="muted">
            Your own range for the solve is a generic top-40% continuing range (your exact hand is
            read out of its equity bucket). For a precise answer, use the Spot Solver with exact
            ranges.
          </p>
        </section>
      )}
    </div>
  );
}

function AdviceView({ advice }: { advice: Advice }) {
  return (
    <div className="advice-box">
      <h3>{advice.title}</h3>
      {advice.mix && advice.mix.length > 0 && (
        <div>
          {advice.mix
            .filter((m) => m.freq > 0.005)
            .map((m) => (
              <div key={m.label} className="freq-row">
                <span>{m.label}</span>
                <span className="freq-bar">
                  <span className="freq-fill" style={{ width: `${m.freq * 100}%` }} />
                </span>
                <span>{(m.freq * 100).toFixed(0)}%</span>
              </div>
            ))}
        </div>
      )}
      {advice.lines.map((l, i) => (
        <p key={i}>{l}</p>
      ))}
      <p className="muted">
        {advice.source}
        {advice.elapsedMs !== undefined && <> · took {(advice.elapsedMs / 1000).toFixed(1)}s</>}
      </p>
    </div>
  );
}
