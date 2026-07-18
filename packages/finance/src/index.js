import Decimal from "decimal.js";

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
});

function decimal(value, field) {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${field} must be a finite decimal value`);
  }
}

function nonNegative(value, field) {
  const parsed = decimal(value, field);
  if (parsed.isNegative()) throw new RangeError(`${field} must not be negative`);
  return parsed;
}

function money(value) {
  return value.toDecimalPlaces(2).toFixed(2);
}

function percentage(value) {
  return value.toDecimalPlaces(2).toFixed(2);
}

function decimalString(value) {
  return value.toString();
}

export function calculateSaleMetrics({ quantity, unitPriceRm, unitCogsRm }) {
  const resolvedQuantity = nonNegative(quantity, "quantity");
  const resolvedUnitPrice = nonNegative(unitPriceRm, "unitPriceRm");
  const resolvedUnitCogs = nonNegative(unitCogsRm, "unitCogsRm");
  const revenue = resolvedQuantity.times(resolvedUnitPrice);
  const cogs = resolvedQuantity.times(resolvedUnitCogs);
  const grossProfit = revenue.minus(cogs);
  const grossMargin = revenue.isZero()
    ? new Decimal(0)
    : grossProfit.dividedBy(revenue).times(100);

  return {
    revenueRm: money(revenue),
    cogsRm: money(cogs),
    grossProfitRm: money(grossProfit),
    grossMarginPct: percentage(grossMargin),
  };
}

export function formatMyr(value) {
  return money(decimal(value, "value"));
}

export function subtractDecimal(left, right) {
  return decimalString(
    decimal(left, "left").minus(decimal(right, "right")),
  );
}

export function calculatePriceFloor({ unitCogsRm, targetGrossMarginPct }) {
  const resolvedUnitCogs = nonNegative(unitCogsRm, "unitCogsRm");
  const targetMargin = nonNegative(targetGrossMarginPct, "targetGrossMarginPct");
  if (targetMargin.greaterThanOrEqualTo(100)) {
    throw new RangeError("targetGrossMarginPct must be less than 100");
  }

  return money(resolvedUnitCogs.dividedBy(new Decimal(1).minus(targetMargin.dividedBy(100))));
}

export function calculatePriceSimulation({
  quantity,
  proposedUnitPriceRm,
  unitCogsRm,
  comparisonGrossProfitRm,
}) {
  const metrics = calculateSaleMetrics({
    quantity,
    unitPriceRm: proposedUnitPriceRm,
    unitCogsRm,
  });
  const response = {
    revenue_rm: metrics.revenueRm,
    cogs_rm: metrics.cogsRm,
    gross_profit_rm: metrics.grossProfitRm,
    gross_margin_pct: metrics.grossMarginPct,
    assumption: "constant_demand",
  };

  if (comparisonGrossProfitRm !== undefined) {
    response.incremental_gross_profit_vs_today_rm = money(
      decimal(metrics.grossProfitRm, "grossProfitRm").minus(
        decimal(comparisonGrossProfitRm, "comparisonGrossProfitRm"),
      ),
    );
  }

  return response;
}

export function calculatePortfolioMetrics(lines) {
  let revenue = new Decimal(0);
  let cogs = new Decimal(0);
  let baselineCogs = new Decimal(0);

  for (const line of lines) {
    const quantity = nonNegative(line.quantity, "quantity");
    const unitPrice = nonNegative(line.unitPriceRm, "unitPriceRm");
    const unitCogs = nonNegative(line.unitCogsRm, "unitCogsRm");
    const baselineUnitCogs = nonNegative(
      line.baselineUnitCogsRm,
      "baselineUnitCogsRm",
    );
    revenue = revenue.plus(quantity.times(unitPrice));
    cogs = cogs.plus(quantity.times(unitCogs));
    baselineCogs = baselineCogs.plus(quantity.times(baselineUnitCogs));
  }

  const grossProfit = revenue.minus(cogs);
  const baselineGrossProfit = revenue.minus(baselineCogs);
  const grossMargin = revenue.isZero()
    ? new Decimal(0)
    : grossProfit.dividedBy(revenue).times(100);
  const baselineGrossMargin = revenue.isZero()
    ? new Decimal(0)
    : baselineGrossProfit.dividedBy(revenue).times(100);

  return {
    revenueRm: money(revenue),
    cogsRm: money(cogs),
    grossProfitRm: money(grossProfit),
    grossMarginPct: percentage(grossMargin),
    baselineGrossMarginPct: percentage(baselineGrossMargin),
    marginChangePercentagePoints: percentage(
      grossMargin.minus(baselineGrossMargin),
    ),
  };
}

export function calculateRevenue(lines) {
  return money(lines.reduce(
    (total, line) => total.plus(
      nonNegative(line.quantity, "quantity").times(
        nonNegative(line.unitPriceRm, "unitPriceRm"),
      ),
    ),
    new Decimal(0),
  ));
}

export function rankCostDrivers(components, maximum = 4) {
  return components
    .map((component) => ({
      name: component.name,
      contribution_rm_per_pack: money(
        decimal(component.currentCostRm, "currentCostRm").minus(
          decimal(component.baselineCostRm, "baselineCostRm"),
        ),
      ),
    }))
    .filter((component) => !decimal(
      component.contribution_rm_per_pack,
      "contribution_rm_per_pack",
    ).isZero())
    .sort((left, right) =>
      decimal(
        right.contribution_rm_per_pack,
        "right.contribution_rm_per_pack",
      ).comparedTo(
        decimal(
          left.contribution_rm_per_pack,
          "left.contribution_rm_per_pack",
        ),
      ))
    .slice(0, maximum);
}

export function resolvePackPriceIncrease({
  currentContributionRm,
  packPriceIncreaseRm,
  packSize,
  usagePerProductUnit = "1",
}) {
  const size = nonNegative(packSize, "packSize");
  if (size.isZero()) throw new RangeError("packSize must be greater than zero");
  const unitIncrease = nonNegative(
    packPriceIncreaseRm,
    "packPriceIncreaseRm",
  ).dividedBy(size);
  const contributionIncrease = unitIncrease.times(
    nonNegative(usagePerProductUnit, "usagePerProductUnit"),
  );

  return {
    contributionIncreaseRm: decimalString(contributionIncrease),
    currentContributionRm: decimalString(
      nonNegative(currentContributionRm, "currentContributionRm").plus(
        contributionIncrease,
      ),
    ),
  };
}

export function sumDecimal(values) {
  return decimalString(values.reduce(
    (total, value) => total.plus(decimal(value, "decimal")),
    new Decimal(0),
  ));
}

export function calculatePurchasedContribution({
  purchaseQuantity,
  packSize,
  totalPriceRm,
  usagePerProductUnit = "1",
}) {
  const quantity = nonNegative(purchaseQuantity, "purchaseQuantity");
  const size = nonNegative(packSize, "packSize");
  if (quantity.isZero() || size.isZero()) {
    throw new RangeError("purchaseQuantity and packSize must be greater than zero");
  }
  const purchasedUnits = quantity.times(size);
  const unitCost = nonNegative(totalPriceRm, "totalPriceRm")
    .dividedBy(purchasedUnits);
  const contribution = unitCost.times(
    nonNegative(usagePerProductUnit, "usagePerProductUnit"),
  );

  return {
    purchaseUnitCostRm: decimalString(unitCost),
    contributionRm: decimalString(contribution),
  };
}

export function decimalIsBelow(value, threshold) {
  return decimal(value, "value").lessThan(decimal(threshold, "threshold"));
}

export function decimalIsZero(value) {
  return decimal(value, "value").isZero();
}

export function decimalEquals(left, right) {
  return decimal(left, "left").equals(decimal(right, "right"));
}
