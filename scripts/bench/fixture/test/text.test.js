import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyFormat } from "../src/text.js";

test("formats text", () => assert.equal(legacyFormat(" hello "), "HELLO"));
