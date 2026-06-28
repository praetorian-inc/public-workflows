// Minimal publishable module for the ts-release.yml self-test fixture.
// Imports a tiny public dependency (ms) so the self-test exercises a real
// `npm ci` resolution from the default public registry — not just a no-op
// install — proving setup-node's scoped-registry config leaves public deps
// resolvable. `build` copies this to dist/; `test` imports the built dist/
// copy (the bytes that get packed and published) and asserts hello() === 'ok'.
import ms from "ms";

export function hello() {
  return ms("1s") === 1000 ? "ok" : "fail";
}
