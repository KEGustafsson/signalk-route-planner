import fc from "fast-check";
import { IdMap } from "../../src/search/id-map";

/** A square's id to a value, held in an array (`search/id-map.ts`): answers as a `Map` does. */

const op = fc.oneof(
  fc.record({ kind: fc.constant("set" as const), id: fc.nat(500), v: fc.integer() }),
  fc.record({ kind: fc.constant("delete" as const), id: fc.nat(600) }),
  fc.record({ kind: fc.constant("ask" as const), id: fc.nat(600) })
);

describe("IdMap", () => {
  test("answers get and has as a Map does, after any sets and deletes", () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 200 }), (ops) => {
        const m = new Map<number, number>();
        const a = new IdMap<number>();
        return ops.every((o) => {
          if (o.kind === "set") {
            m.set(o.id, o.v);
            a.set(o.id, o.v);
          } else if (o.kind === "delete") {
            m.delete(o.id);
            a.delete(o.id);
          }
          return a.get(o.id) === m.get(o.id) && a.has(o.id) === m.has(o.id);
        });
      })
    );
  });

  test("keeps false as a value, and starts with the entries given", () => {
    const a = new IdMap<boolean>([[3, false]]);
    expect(a.has(3)).toBe(true);
    expect(a.get(3)).toBe(false);
    expect(a.has(2)).toBe(false);
  });
});
