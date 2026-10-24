// Card representation and hand evaluation.
//
// A card is an integer 0..51:  rank = card >> 2  (0 = '2', ..., 12 = 'A')
//                               suit = card & 3   (0..3, arbitrary order)
// Hand scores are packed integers; a larger score always beats a smaller one.
//   score = category << 20 | tiebreak ranks in 4-bit nibbles (best first)
// Categories: 0 high card, 1 pair, 2 two pair, 3 trips, 4 straight,
//             5 flush, 6 full house, 7 four of a kind, 8 straight flush.

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc'; // display only; evaluator is suit-symmetric

export function makeCard(rank: number, suit: number): number {
  return (rank << 2) | suit;
}
export function rankOf(card: number): number {
  return card >> 2;
}
export function suitOf(card: number): number {
  return card & 3;
}

export function parseCard(s: string): number {
  const r = RANKS.indexOf(s[0]!.toUpperCase());
  const su = SUITS.indexOf(s[1]!.toLowerCase());
  if (r < 0 || su < 0 || s.length !== 2) throw new Error(`Bad card: ${s}`);
  return makeCard(r, su);
}
export function cardToString(card: number): string {
  return RANKS[rankOf(card)]! + SUITS[suitOf(card)]!;
}
export function parseCards(s: string): number[] {
  return s.trim().split(/\s+/).map(parseCard);
}

// Scratch buffers (single-threaded, non-reentrant use only).
const _rankCount = new Int32Array(13);
const _suitCount = new Int32Array(4);
const _suitMask = new Int32Array(4);

/** Highest straight high-rank (3..12, where 3 = wheel A-2-3-4-5) in a rank mask, or -1. */
function straightHigh(mask: number): number {
  // bits 12..0; check runs of 5 from the top down.
  for (let hi = 12; hi >= 4; hi--) {
    const run = 0b11111 << (hi - 4);
    if ((mask & run) === run) return hi;
  }
  // wheel: A(12),5(3),4(2),3(1),2(0)
  if ((mask & (1 << 12)) !== 0 && (mask & 0b1111) === 0b1111) return 3;
  return -1;
}

/** Fill `out` with the top `n` ranks present in mask (excluding ranks in excludeMask). */
function topRanks(mask: number, excludeMask: number, n: number, out: Int32Array): void {
  let filled = 0;
  for (let r = 12; r >= 0 && filled < n; r--) {
    if ((mask & (1 << r)) !== 0 && (excludeMask & (1 << r)) === 0) {
      out[filled++] = r;
    }
  }
}

function pack(cat: number, t: ArrayLike<number>, n: number): number {
  let s = cat << 20;
  for (let i = 0; i < n; i++) s |= t[i]! << (16 - 4 * i);
  return s;
}

const _tb = new Int32Array(5); // tiebreak ranks, best first

/**
 * Evaluate the best 5-card hand out of 5, 6 or 7 cards.
 * Returns a packed score; higher wins. Ties produce equal scores.
 */
export function evaluate(cards: ArrayLike<number>): number {
  const n = cards.length;
  _rankCount.fill(0);
  _suitCount.fill(0);
  _suitMask[0] = _suitMask[1] = _suitMask[2] = _suitMask[3] = 0;
  let rankMask = 0;
  for (let i = 0; i < n; i++) {
    const c = cards[i]!;
    const r = c >> 2;
    const s = c & 3;
    _rankCount[r]++;
    _suitCount[s]++;
    _suitMask[s] |= 1 << r;
    rankMask |= 1 << r;
  }

  // Flush suit (at most one suit can have >= 5 cards in <= 7 cards).
  let flushSuit = -1;
  for (let s = 0; s < 4; s++) if (_suitCount[s] >= 5) flushSuit = s;

  if (flushSuit >= 0) {
    const sh = straightHigh(_suitMask[flushSuit]);
    if (sh >= 0) {
      _tb[0] = sh;
      return pack(8, _tb, 1); // straight flush
    }
  }

  // Rank multiplicity groups.
  let quad = -1;
  let trip1 = -1;
  let trip2 = -1;
  let pair1 = -1;
  let pair2 = -1;
  for (let r = 12; r >= 0; r--) {
    const cnt = _rankCount[r]!;
    if (cnt === 4) quad = r;
    else if (cnt === 3) {
      if (trip1 < 0) trip1 = r;
      else trip2 = r;
    } else if (cnt === 2) {
      if (pair1 < 0) pair1 = r;
      else if (pair2 < 0) pair2 = r;
    }
  }

  if (quad >= 0) {
    topRanks(rankMask, 1 << quad, 1, _tb);
    const k = _tb[0]!;
    _tb[0] = quad;
    _tb[1] = k;
    return pack(7, _tb, 2);
  }
  if (trip1 >= 0 && (trip2 >= 0 || pair1 >= 0)) {
    _tb[0] = trip1;
    _tb[1] = trip2 >= 0 ? trip2 : pair1;
    return pack(6, _tb, 2); // full house
  }
  if (flushSuit >= 0) {
    topRanks(_suitMask[flushSuit], 0, 5, _tb);
    return pack(5, _tb, 5); // flush
  }
  const sh = straightHigh(rankMask);
  if (sh >= 0) {
    _tb[0] = sh;
    return pack(4, _tb, 1); // straight
  }
  if (trip1 >= 0) {
    topRanks(rankMask, 1 << trip1, 2, _tb);
    const k1 = _tb[0]!;
    const k2 = _tb[1]!;
    _tb[0] = trip1;
    _tb[1] = k1;
    _tb[2] = k2;
    return pack(3, _tb, 3); // three of a kind
  }
  if (pair1 >= 0 && pair2 >= 0) {
    topRanks(rankMask, (1 << pair1) | (1 << pair2), 1, _tb);
    const k = _tb[0]!;
    _tb[0] = pair1;
    _tb[1] = pair2;
    _tb[2] = k;
    return pack(2, _tb, 3); // two pair
  }
  if (pair1 >= 0) {
    topRanks(rankMask, 1 << pair1, 3, _tb);
    const k1 = _tb[0]!;
    const k2 = _tb[1]!;
    const k3 = _tb[2]!;
    _tb[0] = pair1;
    _tb[1] = k1;
    _tb[2] = k2;
    _tb[3] = k3;
    return pack(1, _tb, 4); // one pair
  }
  topRanks(rankMask, 0, 5, _tb);
  return pack(0, _tb, 5); // high card
}

export function categoryOf(score: number): number {
  return score >> 20;
}

export const CATEGORY_NAMES = [
  'high card',
  'one pair',
  'two pair',
  'three of a kind',
  'straight',
  'flush',
  'full house',
  'four of a kind',
  'straight flush',
];

// ---------------------------------------------------------------------------
// Two-card combos and 13x13 hand classes
// ---------------------------------------------------------------------------

export const NUM_COMBOS = 1326;
/** All unordered two-card combos, [c1, c2] with c1 < c2. */
export const COMBOS: ReadonlyArray<readonly [number, number]> = (() => {
  const out: [number, number][] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) out.push([a, b]);
  return out;
})();

const _comboIndex = new Int32Array(52 * 52).fill(-1);
COMBOS.forEach(([a, b], i) => {
  _comboIndex[a * 52 + b] = i;
  _comboIndex[b * 52 + a] = i;
});
export function comboIndex(c1: number, c2: number): number {
  return _comboIndex[c1 * 52 + c2]!;
}

/**
 * 13x13 grid coordinates for a combo. Ranks in UI order: 0 = A ... 12 = 2.
 * Pairs on the diagonal (row === col), suited above (row < col), offsuit below.
 */
export function classGridPos(c1: number, c2: number): { row: number; col: number } {
  const hi = Math.max(rankOf(c1), rankOf(c2));
  const lo = Math.min(rankOf(c1), rankOf(c2));
  const rowHi = 12 - hi;
  const rowLo = 12 - lo;
  if (hi === lo) return { row: rowHi, col: rowHi };
  if (suitOf(c1) === suitOf(c2)) return { row: rowHi, col: rowLo };
  return { row: rowLo, col: rowHi };
}

/** Class index 0..168 = row * 13 + col of the 13x13 grid. */
export function classIndexOf(c1: number, c2: number): number {
  const { row, col } = classGridPos(c1, c2);
  return row * 13 + col;
}

export function className(classIndex: number): string {
  const row = Math.floor(classIndex / 13);
  const col = classIndex % 13;
  const rRow = RANKS[12 - row]!;
  const rCol = RANKS[12 - col]!;
  if (row === col) return rRow + rCol;
  if (row < col) return rRow + rCol + 's';
  return rCol + rRow + 'o';
}

/** Number of combos in each of the 169 classes (6 pair / 4 suited / 12 offsuit). */
export const CLASS_COMBO_COUNT: ReadonlyArray<number> = (() => {
  const counts = new Array<number>(169).fill(0);
  for (const [a, b] of COMBOS) counts[classIndexOf(a, b)]!++;
  return counts;
})();

/** Combos per class. */
export const CLASS_COMBOS: ReadonlyArray<ReadonlyArray<number>> = (() => {
  const out: number[][] = Array.from({ length: 169 }, () => []);
  COMBOS.forEach(([a, b], i) => out[classIndexOf(a, b)]!.push(i));
  return out;
})();

/** Parse a hand class like "AKs", "QQ", "T9o" into its class index. */
export function parseClass(name: string): number {
  const s = name.trim().toUpperCase();
  const r1 = RANKS.indexOf(s[0]!);
  const r2 = RANKS.indexOf(s[1]!);
  if (r1 < 0 || r2 < 0) throw new Error(`Bad hand class: ${name}`);
  const hi = Math.max(r1, r2);
  const lo = Math.min(r1, r2);
  const rowHi = 12 - hi;
  const rowLo = 12 - lo;
  if (hi === lo) return rowHi * 13 + rowHi;
  const suffix = s[2];
  if (suffix === 'S') return rowHi * 13 + rowLo;
  if (suffix === 'O') return rowLo * 13 + rowHi;
  throw new Error(`Hand class needs s/o suffix: ${name}`);
}
