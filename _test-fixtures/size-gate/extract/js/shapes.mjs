export function add(a, b) {
  return a + b;
}

export const double = (n) => n * 2;

export class Counter {
  #count = 0;
  static {
    Counter.zero = new Counter();
  }
  get value() {
    return this.#count;
  }
  increment() {
    this.#count += 1;
  }
}
