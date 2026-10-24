import { className } from '../../engine/cards';

interface Props {
  /** Per-class intensity 0..1 (range weight or action frequency). */
  values: Float64Array;
  /** CSS color (rgb components "r,g,b") used with alpha = value. */
  color: string;
  selectedClass?: number;
  onSelect?: (classIdx: number) => void;
  /** Optional per-class label override (defaults to the class name). */
  cornerLabel?: (classIdx: number) => string | null;
}

/** 13x13 hand-class grid. Rows/cols are ranks A..2; pairs on the diagonal,
 *  suited above it, offsuit below (standard layout). */
export function RangeGrid({ values, color, selectedClass, onSelect, cornerLabel }: Props) {
  return (
    <div className="range-grid" role="grid">
      {Array.from({ length: 13 }, (_, row) =>
        Array.from({ length: 13 }, (_, col) => {
          const ci = row * 13 + col;
          const v = values[ci] ?? 0;
          const label = cornerLabel ? cornerLabel(ci) : null;
          return (
            <button
              key={ci}
              type="button"
              role="gridcell"
              className={`grid-cell${selectedClass === ci ? ' selected' : ''}`}
              style={{
                backgroundColor:
                  v > 0 ? `rgba(${color},${0.15 + 0.85 * Math.min(1, v)})` : undefined,
              }}
              onClick={() => onSelect?.(ci)}
              title={`${className(ci)}: ${(v * 100).toFixed(0)}%`}
            >
              <span className="grid-cell-name">{className(ci)}</span>
              {label && <span className="grid-cell-sub">{label}</span>}
            </button>
          );
        }),
      )}
    </div>
  );
}
