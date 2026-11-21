import type { Session, Verdict } from "../../src/oracle/contract";
import { Guide, memoBoxes } from "../../src/search/guide";

/** The steered search's guide and the box verdicts its two passes share (plan §6, steering). */

describe("guide", () => {
  const path: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10]
  ];

  test("on the path: the way left along it; off it: to its nearest point, then along", () => {
    const g = new Guide(path);
    expect(g.to([0, 0])).toBeCloseTo(20);
    expect(g.to([10, 5])).toBeCloseTo(5);
    // Nearest to the first leg at (5, 0): 3 across, then 5 + 10 along.
    expect(g.to([5, -3])).toBeCloseTo(18);
  });

  test("never less than the straight line to the goal", () => {
    const g = new Guide(path);
    for (const p of [
      [3, 7],
      [-5, -5],
      [12, 2],
      [10, 10]
    ] as [number, number][]) {
      expect(g.to(p)).toBeGreaterThanOrEqual(Math.hypot(10 - p[0], 10 - p[1]) - 1e-9);
    }
  });

  test("a metre the path may find no way through counts its weight", () => {
    const g = new Guide(path, [1, 4]);
    expect(g.to([0, 0])).toBeCloseTo(10 + 40);
    expect(g.to([10, 5])).toBeCloseTo(20);
  });

  test("through the ends' own squares: the path from and to them", () => {
    const g = new Guide(path, [1, 4]).through([-2, 0], [10, 12]);
    expect(g.path[0]).toEqual([-2, 0]);
    expect(g.path[g.path.length - 1]).toEqual([10, 12]);
    expect(g.to([10, 12])).toBeCloseTo(0);
  });
});

describe("memoBoxes", () => {
  test("asks the chart about a box once, about every leg each time", () => {
    const v: Verdict = { status: "ok", risk: 0, flags: [] };
    const boxes: string[] = [];
    let legs = 0;
    const session: Session = {
      halfWidth: 20,
      box: (sw, ne) => {
        boxes.push(`${sw.join()}|${ne.join()}`);
        return v;
      },
      segment: () => {
        legs++;
        return v;
      },
      work: () => boxes.length,
      pause: () => Promise.resolve()
    };
    const m = memoBoxes(session);
    expect(m.box([22, 60], [22.1, 60.1])).toBe(v);
    expect(m.box([22, 60], [22.1, 60.1])).toBe(v);
    expect(m.box([22, 60], [22.2, 60.1])).toBe(v);
    m.segment([22, 60], [22.1, 60.1]);
    m.segment([22, 60], [22.1, 60.1]);
    expect(boxes).toHaveLength(2);
    expect(legs).toBe(2);
    expect(m.halfWidth).toBe(20);
    expect(m.work()).toBe(2);
    // A box over another window is another question.
    m.box([22, 60], [22.1, 60.1], { start: 0, end: 1 });
    expect(boxes).toHaveLength(3);
  });
});
