import type { LonLat } from "../../src/foundation/geo";
import { frameAt } from "../../src/foundation/geo";
import type { Session, Verdict } from "../../src/oracle/contract";
import { stuckEnds } from "../../src/plan/handover";
import { DEFAULT_PLAN } from "../../src/plan/options";
import { QuadTree } from "../../src/search/quadtree";

/** Harbour handovers, on a chart of 10 m unit squares where only chosen squares are free. */

function treeWith(free: (x: number, y: number) => boolean): QuadTree {
  const holder: { tree?: QuadTree } = {};
  const verdict = (ok: boolean): Verdict => ({ status: ok ? "ok" : "fail", risk: 0, flags: [] });
  const session: Session = {
    halfWidth: 0,
    box(sw, ne) {
      const t = holder.tree as QuadTree;
      const [x0, y0] = t.units(sw);
      const [x1, y1] = t.units(ne);
      const unit = Math.round(x1 - x0) === 1 && Math.round(y1 - y0) === 1;
      return verdict(unit && free(Math.round(x0), Math.round(y0)));
    },
    segment: () => verdict(false),
    work: () => 0,
    pause: () => Promise.resolve()
  };
  const tree = new QuadTree(
    { frame: frameAt([22, 60]), x0: 0, y0: 0, unit: 10, side: 64, maxLeaf: 64 },
    session
  );
  holder.tree = tree;
  return tree;
}

describe("harbour handovers", () => {
  test("a handover on the way is offered first, though more than 24 squares lie nearer", () => {
    // 26 free squares in a row just behind the end, and one beyond them toward the other end.
    const tree = treeWith((x, y) => (y === 8 && x >= 20 && x <= 45) || (x === 32 && y === 23));
    const p = tree.lonLat(32.5, 10.5);
    const other = tree.lonLat(32.5, 1000);
    const stuck = stuckEnds(
      tree,
      [p, other],
      { start: true, end: false },
      { ...DEFAULT_PLAN, harbourMetres: 500 },
      { enter: (n) => n.state === "free", joins: () => true, exhausted: () => false }
    );
    const first = stuck !== "work" && stuck?.start?.[0];
    const [ux, uy] = tree.units(first as LonLat);
    expect([Math.round(ux * 2) / 2, Math.round(uy * 2) / 2]).toEqual([32.5, 23.5]);
  });
});
