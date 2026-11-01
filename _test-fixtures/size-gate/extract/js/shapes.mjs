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

export default ((() => 12));

const foo = (() => 13);

const o = { bar: (() => 14), baz: ((() => 15)) };

(() => 16)();

export default (function Foo() {
  return 17;
});

export default (function () {
  return 18;
});
