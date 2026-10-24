// Saved spots in IndexedDB (no dependency; minimal promise wrapper).
// A saved spot stores the full setup (board, class-level ranges, pot,
// stack, abstraction settings) plus the result summary, so a spot can be
// reviewed later and re-solved with one tap. Ranges are stored as
// per-class weights, which is exact for this app: the range editor works
// at class granularity.

export interface SavedSpot {
  id?: number;
  name: string;
  createdAt: number;
  board: number[];
  pot: number;
  stack: number;
  betSizes: number[];
  maxRaises: number;
  numBuckets: number;
  rangeOOPClasses: number[]; // 169 per-class weights
  rangeIPClasses: number[];
  summary: {
    exploitabilityPctPot: number;
    gameValue: number;
    iterations: number;
    aggregateOOP: Array<[string, number]>;
  } | null;
}

const DB_NAME = 'gto-solver-pwa';
const STORE = 'spots';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export function saveSpot(spot: SavedSpot): Promise<number> {
  return tx('readwrite', (s) => s.add(spot)) as Promise<number>;
}

export function listSpots(): Promise<SavedSpot[]> {
  return tx('readonly', (s) => s.getAll()) as Promise<SavedSpot[]>;
}

export function deleteSpot(id: number): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(id)) as Promise<undefined>;
}
