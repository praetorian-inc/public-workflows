// Duplicate-name ordinals (LAB-7587, plan §5.3 step 3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { numberDuplicates } from "./extract.mjs";

const f = (name) => ({ name, start: 1, end: 1, isComponent: false });

test("a repeated name is numbered from its second occurrence; others are untouched", () => {
  const names = numberDuplicates([f("init"), f("App>useEffect"), f("init"), f("x"), f("App>useEffect"), f("init")]).map((g) => g.name);
  assert.deepEqual(names, ["init", "App>useEffect", "init#2", "x", "App>useEffect#2", "init#3"]);
});
