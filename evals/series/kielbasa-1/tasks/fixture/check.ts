// Run with: bun check.ts  (exits non-zero on the first failed assertion)
import assert from "node:assert";
import { sum } from "./sum.ts";

assert.strictEqual(sum([1, 2, 3]), 6);
assert.strictEqual(sum([-1, 1, -2]), -2);
assert.strictEqual(sum([]), 0);
console.log("all checks passed");
