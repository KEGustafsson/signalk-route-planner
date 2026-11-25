import type { LonLat } from "../foundation/geo";
import type { Raster, Session, Verdict } from "../oracle/contract";
import { RASTER, RASTER_STATUS } from "../oracle/contract";
import type { PassRule } from "./passes";
import { passes } from "./passes";
import type { Segment } from "./field-geometry";
import {
  boxCorridor,
  cellSide,
  cellsOf,
  legCorridor,
  rowSpan,
  segmentToSquare,
  WIDE
} from "./field-geometry";

/**
 * A leg tested against the session's raster (planning API feature "raster") instead of asked of
 * the route check: each cell of the raster is one of the chart index's finest tiles with the
 * status a point there has. A leg's corridor is a rectangle around it, the half-width to each
 * side and past each end, and its verdict counts every tile in it and, by the chart's position
 * uncertainty, those within the raster's `reach` of it. So:
 *
 * - where every cell within the corridor and that reach passes the rule, the leg passes;
 * - where a cell no water level opens and no rule accepts lies inside the corridor, it does not;
 * - any other leg is not known here (`undefined`), and the caller asks `segment`.
 *
 * The answer is the route check's own for the first two, at no chart query. It only spares the
 * search questions: the route check still proves every leg of the route offered (invariant 1).
 */

/** Cells per side of a block asked of the session at once. */
const BLOCK = 256;
/**
 * The most cells a scan past a corridor, out to the chart's reach, may read to find a leg or box
 * passes: about what a tenth of the query it spares costs. Past it the query is asked.
 */
const MAX_RING_CELLS = 40_000;
/** A box of at most this many cells is scanned for a closed cell even where it cannot pass here. */
const CHEAP_CELLS = 4_000;

const FREE = 0;
const BAD = 1;
const MAYBE = 2;

/** How a field's legs were answered, for the work profile. */
export interface FieldStats {
  passed: number;
  failed: number;
  asked: number;
  blocks: number;
}

type RasterSession = Session & Required<Pick<Session, "rasterZoom" | "raster">>;

/** Whether `s` serves a raster. */
export function hasRaster(s: Session): s is RasterSession {
  return typeof s.raster === "function" && typeof s.rasterZoom === "number";
}

/** The raster members of `s`, for a session that wraps it; none when it serves no raster. */
export function rasterOf(s: Session): Pick<Session, "rasterZoom" | "raster"> {
  return hasRaster(s)
    ? { rasterZoom: s.rasterZoom, raster: (x0, y0, cols, rows) => s.raster(x0, y0, cols, rows) }
    : {};
}

export class Field {
  readonly stats: FieldStats = { passed: 0, failed: 0, asked: 0, blocks: 0 };
  /** The grid: its cells across the world, and a cell's side on the chart, Mercator metres. */
  private readonly grid: { n: number; cell: number };
  private readonly blocks = new Map<number, Uint8Array>();
  private lastKey = -1;
  private last: Uint8Array | undefined;
  /** The widest chart reach of the blocks read so far, ground metres. */
  private reach = 0;

  /**
   * `rule` must hold a verdict to the probability the session scores with, as a plan's does:
   * a cell's risk is given as at or above that probability, or below it.
   */
  constructor(
    private readonly session: RasterSession,
    private readonly rule: PassRule
  ) {
    this.grid = { n: 2 ** session.rasterZoom, cell: cellSide(session.rasterZoom) };
  }

  /** The classes of the block holding cell (x, y): FREE, BAD or MAYBE each. */
  private block(x: number, y: number): Uint8Array {
    const bx = Math.floor(x / BLOCK);
    const by = Math.floor(y / BLOCK);
    const key = by * 16_777_216 + bx;
    if (key === this.lastKey && this.last) {
      return this.last;
    }
    let b = this.blocks.get(key);
    if (!b) {
      b = this.fetch(bx * BLOCK, by * BLOCK);
      this.blocks.set(key, b);
    }
    this.lastKey = key;
    this.last = b;
    return b;
  }

  /** The block whose north-west cell is (x0, y0), classed; all MAYBE where there is no raster. */
  private fetch(x0: number, y0: number): Uint8Array {
    const out = new Uint8Array(BLOCK * BLOCK).fill(MAYBE);
    const cols = Math.min(BLOCK, this.grid.n - x0);
    const rows = Math.min(BLOCK, this.grid.n - y0);
    if (x0 < 0 || y0 < 0 || cols < 1 || rows < 1) {
      return out;
    }
    let r: Raster;
    try {
      r = this.session.raster(x0, y0, cols, rows);
    } catch (err) {
      if (err instanceof RangeError) {
        return out;
      }
      throw err;
    }
    this.stats.blocks++;
    this.reach = Math.max(this.reach, r.reach);
    // What the rule makes of each flag set: of an `ok` verdict with it, and of an `unverified`
    // one at a risk under the probability.
    const sets = r.flagSets.map((flags) => {
      const at = (status: Verdict["status"]): boolean =>
        passes({ status, risk: -Infinity, flags }, this.rule);
      return { ok: at("ok"), unverified: at("unverified") };
    });
    // Each cell's class by its byte and flag set, told once: -1 while not yet told.
    const classes = new Int16Array(256 * Math.max(1, sets.length)).fill(-1);
    for (let j = 0; j < r.rows; j++) {
      for (let i = 0; i < r.cols; i++) {
        const k = j * r.cols + i;
        const byte = r.cells[k] as number;
        const set = r.flags[k] as number;
        const at = set * 256 + byte;
        let c = classes[at] ?? -1;
        if (c < 0) {
          c = classOf(byte, sets[set]);
          if (at < classes.length) {
            classes[at] = c;
          }
        }
        out[j * BLOCK + i] = c;
      }
    }
    return out;
  }

  private counted(known: boolean | undefined): boolean | undefined {
    if (known === undefined) {
      this.stats.asked++;
    } else if (known) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
    }
    return known;
  }

  /**
   * Whether every cell within the chart's reach of a corridor passes too, once its own cells
   * do: `ring(hold)` scans out to `hold` cells and `cells(hold)` says how many that reads. True
   * with no reach to scan, or none but free cells in it; undefined with any other, or where the
   * reach is so wide (a chart of poor survey quality counts tiles kilometres off) that the scan
   * would cost more than the query it spares. The reach is the widest of the blocks read so
   * far, and a block the scan reads may widen it, so it is made again until it does not.
   */
  private clearBeyond(
    base: number,
    small: number,
    ring: (hold: number) => number,
    cells: (hold: number) => number
  ): true | undefined {
    for (let pass = 0; pass < 3; pass++) {
      const reach = this.reach;
      if (reach === 0) {
        return true;
      }
      const hold = base + (reach * WIDE) / small;
      if (cells(hold) > MAX_RING_CELLS) {
        return undefined;
      }
      const found = ring(hold);
      if (this.reach === reach) {
        return found === FREE ? true : undefined;
      }
    }
    return undefined;
  }

  /**
   * Whether the leg a → b passes the rule at the session's corridor: true or false where the
   * raster settles it as the route check would, undefined where it does not.
   */
  leg(a: LonLat, b: LonLat): boolean | undefined {
    const c = legCorridor(a, b, this.session.halfWidth, this.grid);
    if (!c) {
      return this.counted(undefined);
    }
    // The corridor's own cells first: a closed one inside settles it, any other not free
    // leaves it to the exact check, and only a corridor all free is worth the reach past it.
    const core = this.scan(c.long, c.leg, c.half, c.inside, false);
    if (core !== FREE) {
      return this.counted(core === BAD ? false : undefined);
    }
    const length = Math.hypot(c.long[2] - c.long[0], c.long[3] - c.long[1]);
    return this.counted(
      this.clearBeyond(
        c.half,
        c.small,
        (hold) => this.scan(c.long, c.leg, hold, 0, true),
        (hold) => (length + 2 * hold) * (2 * hold + 1)
      )
    );
  }

  /**
   * Whether the box sw–ne passes the rule as the session's `box` verdict does: every leg in it
   * with its corridor. True where every cell the verdict counts passes, false where a cell
   * closed at any water lies in the box itself, undefined where the raster does not settle it.
   */
  box(sw: LonLat, ne: LonLat): boolean | undefined {
    const c = boxCorridor(sw, ne, this.session.halfWidth, this.grid);
    if (!c) {
      return this.counted(undefined);
    }
    const cells = (hold: number): number =>
      (c.box[2] - c.box[0] + 2 * hold + 1) * (c.box[3] - c.box[1] + 2 * hold + 1);
    // A large box whose reach is too wide to scan cannot pass here: it is not scanned for a
    // closed cell either, which the exact check it is left to finds as soon.
    const wide = this.reach > 0 && cells(c.grow + (this.reach * WIDE) / c.small) > MAX_RING_CELLS;
    if (wide && cells(c.grow) > CHEAP_CELLS) {
      return this.counted(undefined);
    }
    const core = this.scanBox(c.box, c.grow, false);
    if (core !== FREE) {
      return this.counted(core === BAD ? false : undefined);
    }
    return this.counted(
      this.clearBeyond(c.grow, c.small, (hold) => this.scanBox(c.box, hold, true), cells)
    );
  }

  /**
   * Calls `each` with every cell of row `y` from column `xs` to `xe` that is not free, with its
   * class, until it returns false; false when it was stopped. The row must lie on the grid.
   */
  private notFree(
    y: number,
    xs: number,
    xe: number,
    each: (x: number, c: number) => boolean
  ): boolean {
    const at = (y % BLOCK) * BLOCK;
    let x = xs;
    while (x <= xe) {
      const block = this.block(x, y);
      const end = Math.min(xe, x + BLOCK - 1 - (x % BLOCK));
      for (; x <= end; x++) {
        const c = block[at + (x % BLOCK)] as number;
        if (c !== FREE && !each(x, c)) {
          return false;
        }
      }
    }
    return true;
  }

  /** Whether row `y` from column `xs` to `xe` lies off the chart's grid: nothing is known of it. */
  private off(y: number, xs: number, xe: number): boolean {
    const { n } = this.grid;
    return y < 0 || y >= n || xs < 0 || xe >= n;
  }

  /**
   * The cells meeting the rectangle `box` grown by `hold`, in cells: FREE when every one is,
   * BAD when one that is lies inside `box` itself, else MAYBE. With `first`, MAYBE at the first
   * cell not free: all the caller asks is whether there is one.
   */
  private scanBox(box: Segment, hold: number, first: boolean): number {
    const [x0, y0, x1, y1] = box;
    const xs = Math.floor(x0 - hold);
    const xe = Math.floor(x1 + hold);
    let found = FREE;
    for (let y = Math.floor(y0 - hold); y <= Math.floor(y1 + hold); y++) {
      if (this.off(y, xs, xe)) {
        found = MAYBE;
        continue;
      }
      const through = this.notFree(y, xs, xe, (x, c) => {
        // Inside the box proper: the cell holds ground of it, not just an edge.
        const inside = x + 1 > x0 && x < x1 && y + 1 > y0 && y < y1;
        found = !first && c === BAD && inside ? BAD : MAYBE;
        return found !== BAD && !first;
      });
      if (!through) {
        return found;
      }
    }
    return found;
  }

  /**
   * The cells within `hold` of the leg drawn on past its ends, `long`: FREE when every one is,
   * BAD when one that is lies within `inside` of the leg itself, `leg`, else MAYBE. With
   * `first`, MAYBE at the first cell not free.
   */
  private scan(long: Segment, leg: Segment, hold: number, inside: number, first: boolean): number {
    let found = FREE;
    const y0 = Math.floor(Math.min(long[1], long[3]) - hold);
    const y1 = Math.floor(Math.max(long[1], long[3]) + hold);
    for (let y = y0; y <= y1; y++) {
      const [xs, xe] = rowSpan(long, y, hold);
      if (this.off(y, xs, xe)) {
        found = MAYBE;
        continue;
      }
      const through = this.notFree(y, xs, xe, (x, c) => {
        if (segmentToSquare(long, x, y) > hold) {
          return true;
        }
        const closed = c === BAD && inside > 0 && segmentToSquare(leg, x, y) < inside;
        found = closed ? BAD : MAYBE;
        return !closed && !first;
      });
      if (!through) {
        return found;
      }
    }
    return found;
  }
}

/** A cell's class under a rule: `set` says what the rule makes of the cell's flags. */
function classOf(byte: number, set: { ok: boolean; unverified: boolean } | undefined): number {
  if (byte & RASTER.ASK || !set) {
    return MAYBE;
  }
  const status = RASTER_STATUS[byte & RASTER.STATUS];
  const risky = (byte & RASTER.RISKY) !== 0;
  if ((status === "ok" && set.ok) || (status === "unverified" && set.unverified && !risky)) {
    return FREE;
  }
  if (byte & RASTER.MIXED) {
    return MAYBE;
  }
  // Closed at any water: land or a shoal no level in the window covers, or flags the rule
  // does not accept, which a water level does not change.
  const closed = (byte & RASTER.STUCK) !== 0 || (status === "unverified" && !set.unverified);
  return closed ? BAD : MAYBE;
}

/** What a leg the field settles is given as: only whether it passes is known of it. */
const SURE_PASS: Verdict = { status: "ok", risk: 0, flags: [] };
const SURE_FAIL: Verdict = { status: "fail", risk: 1, flags: [] };

/**
 * A leg check for a search that reads no more of a verdict than whether `rule` passes it:
 * settled on the session's raster where it can be, else by `exact`. Where the session serves no
 * raster, `exact` itself. With `stats`, the field's counts are kept there.
 */
export function settledCheck(
  session: Session,
  rule: PassRule,
  exact: (a: LonLat, b: LonLat) => Verdict
): (a: LonLat, b: LonLat) => Verdict {
  const field = fieldOf(session, rule);
  if (!field) {
    return exact;
  }
  return (a, b) => {
    const known = field.leg(a, b);
    return known === undefined ? exact(a, b) : known ? SURE_PASS : SURE_FAIL;
  };
}

const fields = new WeakMap<Session, Map<string, Field>>();

/** The session's field under `rule`, one for the session; undefined where it serves no raster. */
export function fieldOf(session: Session, rule: PassRule): Field | undefined {
  if (!hasRaster(session)) {
    return undefined;
  }
  let held = fields.get(session);
  if (!held) {
    held = new Map();
    fields.set(session, held);
  }
  const key = `${String(rule.probability)}|${rule.accept.join(",")}`;
  let field = held.get(key);
  if (!field) {
    field = new Field(session, rule);
    held.set(key, field);
  }
  return field;
}
