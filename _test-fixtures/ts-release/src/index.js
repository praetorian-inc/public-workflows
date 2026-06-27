// Minimal publishable module for the ts-release.yml self-test fixture.
// `build` copies this to dist/; `test` imports it and asserts hello() === 'ok'.
export function hello() {
  return "ok";
}
