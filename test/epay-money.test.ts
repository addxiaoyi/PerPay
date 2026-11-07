import assert from "node:assert/strict";
import { it } from "node:test";

import { parseLegacyCents } from "../src/epay-compat/money.ts";

it("converts decimal currency without floating point rounding", () => {
  assert.equal(parseLegacyCents("0.29"), 29);
  assert.equal(parseLegacyCents("123456789.01"), 12345678901);
  assert.equal(parseLegacyCents("1.5"), 150);
  for (const value of ["1.001", "-1", "1e3", "", "90071992547409.92"]) {
    assert.throws(() => parseLegacyCents(value));
  }
});
