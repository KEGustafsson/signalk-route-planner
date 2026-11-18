/** A binary min-heap of items by key, for the searches over the quadtree. */
export class Heap<T> {
  private readonly a: { v: T; k: number }[] = [];

  get size(): number {
    return this.a.length;
  }

  /** The smallest key, or Infinity when empty. */
  peekKey(): number {
    return this.a[0]?.k ?? Infinity;
  }

  push(v: T, k: number): void {
    const a = this.a;
    a.push({ v, k });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((a[p] as { k: number }).k <= k) {
        break;
      }
      [a[i], a[p]] = [a[p] as { v: T; k: number }, a[i] as { v: T; k: number }];
      i = p;
    }
  }

  pop(): T {
    const a = this.a;
    const top = a[0] as { v: T; k: number };
    const last = a.pop() as { v: T; k: number };
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && (a[l] as { k: number }).k < (a[m] as { k: number }).k) {
          m = l;
        }
        if (r < a.length && (a[r] as { k: number }).k < (a[m] as { k: number }).k) {
          m = r;
        }
        if (m === i) {
          break;
        }
        [a[i], a[m]] = [a[m] as { v: T; k: number }, a[i] as { v: T; k: number }];
        i = m;
      }
    }
    return top.v;
  }
}
