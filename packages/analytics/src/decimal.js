const POWERS_OF_TEN = [1n];

function powerOfTen(exponent) {
  while (POWERS_OF_TEN.length <= exponent) {
    POWERS_OF_TEN.push(POWERS_OF_TEN.at(-1) * 10n);
  }
  return POWERS_OF_TEN[exponent];
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function decimal(value, field) {
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError(`${field} must be a finite decimal value`);

  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0) - fraction.length;
  let numerator = sign * BigInt(`${match[2]}${fraction}`);
  let denominator = 1n;

  if (exponent >= 0) numerator *= powerOfTen(exponent);
  else denominator = powerOfTen(-exponent);

  return normalize({ numerator, denominator });
}

function normalize(value) {
  if (value.denominator === 0n) throw new RangeError("division by zero");
  const sign = value.denominator < 0n ? -1n : 1n;
  const divisor = gcd(value.numerator, value.denominator);
  return {
    numerator: sign * value.numerator / divisor,
    denominator: sign * value.denominator / divisor,
  };
}

export function add(left, right) {
  return normalize({
    numerator:
      left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

export function subtract(left, right) {
  return normalize({
    numerator:
      left.numerator * right.denominator - right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

export function multiply(left, right) {
  return normalize({
    numerator: left.numerator * right.numerator,
    denominator: left.denominator * right.denominator,
  });
}

export function divide(left, right) {
  if (right.numerator === 0n) throw new RangeError("division by zero");
  return normalize({
    numerator: left.numerator * right.denominator,
    denominator: left.denominator * right.numerator,
  });
}

export function compare(left, right) {
  const difference =
    left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function isNegative(value) {
  return value.numerator < 0n;
}

export function fixed(value, places) {
  const scale = powerOfTen(places);
  const negative = value.numerator < 0n;
  const absolute = negative ? -value.numerator : value.numerator;
  let rounded = absolute * scale / value.denominator;
  const remainder = absolute * scale % value.denominator;
  if (remainder * 2n >= value.denominator) rounded += 1n;

  const digits = rounded.toString().padStart(places + 1, "0");
  const body = places === 0
    ? digits
    : `${digits.slice(0, -places)}.${digits.slice(-places)}`;
  return `${negative && rounded !== 0n ? "-" : ""}${body}`;
}

export function canonical(value, maximumPlaces = 12) {
  const rendered = fixed(value, maximumPlaces);
  if (!rendered.includes(".")) return rendered;
  return rendered.replace(/\.?0+$/, "");
}
