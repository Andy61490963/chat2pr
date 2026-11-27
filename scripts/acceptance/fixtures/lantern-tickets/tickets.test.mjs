import assert from "node:assert/strict";
import test from "node:test";
import { countTickets } from "./tickets.mjs";

test("合計各批燈會票數，而非批數", () => {
  assert.equal(countTickets([2, 3]), 5);
});

test("尚未出票時總數為零", () => {
  assert.equal(countTickets([]), 0);
});
