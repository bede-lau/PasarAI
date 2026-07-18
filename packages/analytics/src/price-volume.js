import {
  add,
  canonical,
  compare,
  decimal,
  divide,
  fixed,
  isNegative,
  multiply,
  subtract,
} from "./decimal.js";

const HUNDRED = decimal("100", "constant");
const ZERO = decimal("0", "constant");

function nonNegative(value, field) {
  const parsed = decimal(value, field);
  if (isNegative(parsed)) throw new RangeError(`${field} must not be negative`);
  return parsed;
}

function lessThanHundred(value, field) {
  const parsed = nonNegative(value, field);
  if (compare(parsed, HUNDRED) >= 0) {
    throw new RangeError(`${field} must be less than 100`);
  }
  return parsed;
}

function steppedLevels(center, stepPct) {
  const step = divide(stepPct, HUNDRED);
  return [
    multiply(center, subtract(decimal("1", "constant"), step)),
    center,
    multiply(center, add(decimal("1", "constant"), step)),
  ];
}

function metrics(quantity, unitPrice, unitCogs) {
  const revenue = multiply(quantity, unitPrice);
  const cogs = multiply(quantity, unitCogs);
  const grossProfit = subtract(revenue, cogs);
  const grossMargin = compare(revenue, ZERO) === 0
    ? ZERO
    : multiply(divide(grossProfit, revenue), HUNDRED);
  return { revenue, cogs, grossProfit, grossMargin };
}

export function buildPriceVolumeMatrix(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const centerPrice = nonNegative(
    options.centerUnitPriceRm ?? options.centerPriceRm,
    "centerUnitPriceRm",
  );
  const centerQuantity = nonNegative(options.centerQuantity, "centerQuantity");
  const unitCogs = nonNegative(options.unitCogsRm, "unitCogsRm");
  const priceStepPct = lessThanHundred(
    options.priceStepPct ?? "10",
    "priceStepPct",
  );
  const quantityStepPct = lessThanHundred(
    options.quantityStepPct ?? "10",
    "quantityStepPct",
  );
  const targetMargin = options.targetGrossMarginPct === undefined
    ? undefined
    : lessThanHundred(
      options.targetGrossMarginPct,
      "targetGrossMarginPct",
    );
  const selectedPrice = options.selectedUnitPriceRm === undefined
    ? centerPrice
    : nonNegative(options.selectedUnitPriceRm, "selectedUnitPriceRm");
  const selectedQuantity = options.selectedQuantity === undefined
    ? centerQuantity
    : nonNegative(options.selectedQuantity, "selectedQuantity");

  const priceLevels = steppedLevels(centerPrice, priceStepPct);
  const quantityLevels = steppedLevels(centerQuantity, quantityStepPct);
  const baseline = metrics(centerQuantity, centerPrice, unitCogs);
  const selectedPriceIndex = options.selectedUnitPriceRm === undefined
    ? 1
    : priceLevels.findIndex((value) => compare(value, selectedPrice) === 0);
  const selectedQuantityIndex = options.selectedQuantity === undefined
    ? 1
    : quantityLevels.findIndex((value) => compare(value, selectedQuantity) === 0);

  const matrix = quantityLevels.map((quantity, quantityIndex) =>
    priceLevels.map((unitPrice, priceIndex) => {
      const scenario = metrics(quantity, unitPrice, unitCogs);
      return {
        priceIndex,
        quantityIndex,
        unitPriceRm: fixed(unitPrice, 2),
        quantity: canonical(quantity, 4),
        current: priceIndex === 1 && quantityIndex === 1,
        selected:
          priceIndex === selectedPriceIndex
          && quantityIndex === selectedQuantityIndex,
        revenueRm: fixed(scenario.revenue, 2),
        cogsRm: fixed(scenario.cogs, 2),
        grossProfitRm: fixed(scenario.grossProfit, 2),
        grossMarginPct: fixed(scenario.grossMargin, 2),
        incrementalGrossProfitRm: fixed(
          subtract(scenario.grossProfit, baseline.grossProfit),
          2,
        ),
        targetMarginViable: targetMargin === undefined
          ? null
          : compare(scenario.grossMargin, targetMargin) >= 0,
      };
    })
  );

  return {
    priceLevelsRm: priceLevels.map((value) => fixed(value, 2)),
    quantityLevels: quantityLevels.map((value) => canonical(value, 4)),
    matrix,
    assumptions: {
      model: "independent_price_volume_scenarios",
      priceStepPct: canonical(priceStepPct),
      quantityStepPct: canonical(quantityStepPct),
      unitCogsRm: fixed(unitCogs, 2),
      targetGrossMarginPct:
        targetMargin === undefined ? null : fixed(targetMargin, 2),
      cogsBehavior: "constant_unit_cogs",
      interpolation: "none",
      currencyRounding: "half_up_2dp_at_output",
      quantityRounding: "half_up_4dp_at_output",
    },
  };
}
