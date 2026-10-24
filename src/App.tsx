import { useEffect, useState } from 'react';
import { SolverScreen } from './screens/SolverScreen';
import { AdvisorScreen } from './screens/AdvisorScreen';
import { ChartsScreen } from './screens/ChartsScreen';
import { registerPwa } from './pwa';

type Tab = 'solver' | 'advisor' | 'charts';

export function App() {
  const [tab, setTab] = useState<Tab>('solver');
  const [updateReady, setUpdateReady] = useState<null | (() => void)>(null);
  const [storageNote, setStorageNote] = useState<string>('');

  useEffect(() => {
    const cleanup = registerPwa((applyUpdate) => setUpdateReady(() => applyUpdate));
    // Ask the browser to keep our cache (best effort; iOS may still evict).
    if (navigator.storage?.persist) {
      navigator.storage
        .persist()
        .then((granted) => {
          setStorageNote(
            granted
              ? 'Persistent storage granted.'
              : 'Persistent storage not granted — iOS may evict offline data if the app is unused for a long time.',
          );
        })
        .catch(() => undefined);
    }
    return cleanup;
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>GTO Solver</h1>
        <p className="tagline">Offline poker study tool</p>
      </header>

      {updateReady && (
        <div className="update-banner" role="alert">
          <span>A new version is available.</span>
          <button type="button" className="btn small primary" onClick={() => updateReady()}>
            Update now
          </button>
          <button type="button" className="btn small" onClick={() => setUpdateReady(null)}>
            Later
          </button>
        </div>
      )}

      <nav className="tab-bar" aria-label="Main">
        <button
          type="button"
          className={tab === 'solver' ? 'tab active' : 'tab'}
          onClick={() => setTab('solver')}
        >
          Spot Solver
        </button>
        <button
          type="button"
          className={tab === 'advisor' ? 'tab active' : 'tab'}
          onClick={() => setTab('advisor')}
        >
          Quick Advisor
        </button>
        <button
          type="button"
          className={tab === 'charts' ? 'tab active' : 'tab'}
          onClick={() => setTab('charts')}
        >
          Preflop Charts
        </button>
      </nav>

      <main>
        {tab === 'solver' && <SolverScreen />}
        {tab === 'advisor' && <AdvisorScreen />}
        {tab === 'charts' && <ChartsScreen />}
      </main>

      <footer className="app-footer">
        <p>
          <strong>Study use only.</strong> Using real-time assistance while playing online poker
          violates most poker sites' rules and can get accounts banned and funds seized. This app
          is for offline study and review away from the tables.
        </p>
        <p className="muted">
          Solver outputs are for an abstracted game (equity buckets, one street of betting,
          future streets collapsed into showdown equity) and are always shown with the abstract
          game's exploitability. They are not exact full-game GTO solutions. {storageNote}
        </p>
      </footer>
    </div>
  );
}
