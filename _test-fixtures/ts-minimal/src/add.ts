// Touched whenever a ts-ci.yml change needs the live harness run: the
// preflight has_ts gate skips every downstream job on a workflow-only diff,
// so a fixture edit is what makes test-ts-ci.yml actually exercise ts-ci.
export function add(a: number, b: number): number {
  return a + b;
}
