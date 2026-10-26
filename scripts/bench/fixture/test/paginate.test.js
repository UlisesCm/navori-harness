import { test } from "node:test";
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.js";

// Activated in tracked bytes by the operator immediately before task 2.
test.skip("paginate starts at the first page", () => {
  assert.deepEqual(paginate(["a", "b", "c", "d"], 1, 2), ["a", "b"]);
});
