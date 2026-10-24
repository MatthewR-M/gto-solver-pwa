import { RANKS, SUITS, makeCard, rankOf, suitOf } from '../../engine/cards';

const SUIT_SYMBOL = ['♠', '♥', '♦', '♣'];
const SUIT_COLOR = ['#e8e8e8', '#ff6b6b', '#6bb8ff', '#7be495'];

export function cardLabel(card: number): string {
  return RANKS[rankOf(card)]! + SUIT_SYMBOL[suitOf(card)]!;
}

interface Props {
  selected: number[];
  max: number;
  onChange: (cards: number[]) => void;
  disabledCards?: number[];
}

/** Tap-to-select card grid (4 suit rows x 13 ranks). */
export function CardPicker({ selected, max, onChange, disabledCards = [] }: Props) {
  const sel = new Set(selected);
  const dis = new Set(disabledCards);
  const toggle = (card: number) => {
    if (dis.has(card)) return;
    if (sel.has(card)) onChange(selected.filter((c) => c !== card));
    else if (selected.length < max) onChange([...selected, card]);
  };
  return (
    <div className="card-picker">
      {[0, 1, 2, 3].map((suit) => (
        <div className="card-row" key={suit}>
          {Array.from({ length: 13 }, (_, i) => 12 - i).map((rank) => {
            const card = makeCard(rank, suit);
            const isSel = sel.has(card);
            return (
              <button
                key={card}
                type="button"
                className={`card-btn${isSel ? ' selected' : ''}`}
                style={{ color: SUIT_COLOR[suit] }}
                disabled={dis.has(card)}
                onClick={() => toggle(card)}
                aria-pressed={isSel}
              >
                {RANKS[rank]}
                {SUIT_SYMBOL[suit]}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function CardsDisplay({ cards }: { cards: number[] }) {
  if (cards.length === 0) return <span className="muted">none</span>;
  return (
    <span className="cards-display">
      {cards.map((c) => (
        <span key={c} className="card-chip" style={{ color: SUIT_COLOR[suitOf(c)] }}>
          {cardLabel(c)}
        </span>
      ))}
    </span>
  );
}

export { SUITS };
