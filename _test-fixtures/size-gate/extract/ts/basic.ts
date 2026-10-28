export function plain(): number {
  return 1;
}

function over(a: string): string;
function over(a: number): number;
function over(a: unknown): unknown {
  return a;
}

@sealed
export class Svc {
  private n = 0;
  handler = () => {
    return this.n;
  };

  constructor(n: number) {
    this.n = n;
  }

  @logged
  run(): void {
    const inner = () => 1;
    inner();
  }

  get size(): number {
    return this.n;
  }

  set size(v: number) {
    this.n = v;
  }

  abstractish(): void;
  abstractish(): void {}
}

const api = {
  fetch() {
    return 2;
  },
  load: function () {
    return 3;
  },
};

export function Outer() {
  function inner() {
    return 4;
  }
  [1, 2].map((x) => x + 1);
  setTimeout(() => {}, 1);
  setTimeout(() => {}, 2);
  return inner();
}

export default () => 5;
