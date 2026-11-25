/**
 * A map from a square's id to a value, as a `Map` is, held in an array: ids are small integers
 * counted up from 0 within a tree, and a search asks these maps several times a square. The
 * array is grown in order, so it stays a dense list and never becomes a sparse dictionary.
 */
export class IdMap<T> {
  private readonly a: (T | undefined)[] = [];

  constructor(entries: [number, T][] = []) {
    for (const [k, v] of entries) {
      this.set(k, v);
    }
  }

  get(id: number): T | undefined {
    return this.a[id];
  }

  has(id: number): boolean {
    return this.a[id] !== undefined;
  }

  set(id: number, v: T): void {
    while (this.a.length <= id) {
      this.a.push(undefined);
    }
    this.a[id] = v;
  }

  delete(id: number): void {
    if (id < this.a.length) {
      this.a[id] = undefined;
    }
  }
}
