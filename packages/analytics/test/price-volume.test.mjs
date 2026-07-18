import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPriceVolumeMatrix } from "../src/index.js";

test("builds a deterministic 3x3 matrix with exact financial outputs", () => {
  const input = {
    centerUnitPriceRm: "5.00",
    centerQuantity: "40",
    unitCogsRm: "3.18",
    priceStepPct: "10",
    quantityStepPct: "12.5",
    selectedUnitPriceRm: "5.50",
    selectedQuantity: "35",
    targetGrossMarginPct: "40",
  };
  const result = buildPriceVolumeMatrix(input);

  assert.deepEqual(result.priceLevelsRm, ["4.50", "5.00", "5.50"]);
  assert.deepEqual(result.quantityLevels, ["35", "40", "45"]);
  assert.equal(result.matrix.length, 3);
  assert.ok(result.matrix.every((row) => row.length === 3));
  assert.deepEqual(result.matrix[1][1], {
    priceIndex: 1,
    quantityIndex: 1,
    unitPriceRm: "5.00",
    quantity: "40",
    current: true,
    selected: false,
    revenueRm: "200.00",
    cogsRm: "127.20",
    grossProfitRm: "72.80",
    grossMarginPct: "36.40",
    incrementalGrossProfitRm: "0.00",
    targetMarginViable: false,
  });
  assert.deepEqual(result.matrix[0][2], {
    priceIndex: 2,
    quantityIndex: 0,
    unitPriceRm: "5.50",
    quantity: "35",
    current: false,
    selected: true,
    revenueRm: "192.50",
    cogsRm: "111.30",
    grossProfitRm: "81.20",
    grossMarginPct: "42.18",
    incrementalGrossProfitRm: "8.40",
    targetMarginViable: true,
  });
  assert.deepEqual(buildPriceVolumeMatrix(input), result);
});

test("uses decimal-safe half-up scenario boundaries and defaults selection to current", () => {
  const result = buildPriceVolumeMatrix({
    centerPriceRm: "1.005",
    centerQuantity: "3",
    unitCogsRm: "0.333333",
    priceStepPct: "0",
    quantityStepPct: "0",
  });

  assert.equal(result.priceLevelsRm[1], "1.01");
  assert.equal(result.matrix[1][1].revenueRm, "3.02");
  assert.equal(result.matrix[1][1].cogsRm, "1.00");
  assert.equal(result.matrix[1][1].grossProfitRm, "2.02");
  assert.equal(result.matrix[1][1].current, true);
  assert.equal(result.matrix[1][1].selected, true);
  assert.equal(result.matrix.flat().filter((cell) => cell.current).length, 1);
  assert.equal(result.matrix.flat().filter((cell) => cell.selected).length, 1);
});

test("validates matrix inputs and target margin", () => {
  assert.throws(
    () => buildPriceVolumeMatrix({
      centerUnitPriceRm: "5",
      centerQuantity: "-1",
      unitCogsRm: "3",
    }),
    /centerQuantity must not be negative/,
  );
  assert.throws(
    () => buildPriceVolumeMatrix({
      centerUnitPriceRm: "5",
      centerQuantity: "1",
      unitCogsRm: "3",
      targetGrossMarginPct: "100",
    }),
    /must be less than 100/,
  );
});
