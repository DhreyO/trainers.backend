// Trade reconciliation between two back-office systems.
//
// A trade from system A is matched iff:
//   1. system B has a record with the same trade_id,
//   2. that trade_id appears exactly once in system B (duplicates in B are
//      unreliable and can never match), and
//   3. abs(price_a - price_b) < tolerance (strict).
//
// Prices are compared with exact decimal arithmetic rather than floating
// point, so e.g. |0.3 - 0.2| < 0.1 is correctly false (in floats it is
// 0.09999999999999998, which would wrongly match).

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

// Parse a number or numeric string into an exact decimal { units, scale }
// where value = units * 10^-scale.
function toDecimal(value, label) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite, got ${value}`);
    text = String(value); // shortest round-trip form, e.g. 0.3 -> "0.3"
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new TypeError(`${label} must be a number or numeric string, got ${typeof value}`);
  }

  const m = DECIMAL_RE.exec(text);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new TypeError(`${label} is not a valid number: ${JSON.stringify(value)}`);
  }
  const [, sign, intPart, fracPart = '', expPart = '0'] = m;
  let units = BigInt((intPart || '0') + fracPart);
  let scale = fracPart.length - Number(expPart);
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units: sign === '-' ? -units : units, scale };
}

function rescale(d, scale) {
  return d.units * 10n ** BigInt(scale - d.scale);
}

// Exact check of |a - b| < tolerance.
function withinTolerance(a, b, tolerance) {
  const scale = Math.max(a.scale, b.scale, tolerance.scale);
  let diff = rescale(a, scale) - rescale(b, scale);
  if (diff < 0n) diff = -diff;
  return diff < rescale(tolerance, scale);
}

function validateTradeId(id, label) {
  if (typeof id !== 'string' || id.length === 0 || /\s/.test(id)) {
    throw new TypeError(`${label} must be a non-empty whitespace-free string, got ${JSON.stringify(id)}`);
  }
}

// Accepts records as { trade_id, price } objects or [trade_id, price] tuples.
function normalize(record, label) {
  const [trade_id, price] = Array.isArray(record)
    ? record
    : [record && record.trade_id, record && record.price];
  validateTradeId(trade_id, `${label}.trade_id`);
  return { trade_id, price, decimal: toDecimal(price, `${label}.price`) };
}

/**
 * Reconcile system A against system B.
 *
 * Every record in A is judged independently (a trade_id repeated in A can
 * match the same unique B record more than once).
 *
 * @returns {{ matched: Array, unmatched: Array }}
 *   matched:   [{ trade_id, price_a, price_b }]
 *   unmatched: [{ trade_id, price_a, reason, price_b? }]
 *     reason is 'missing_in_b' | 'duplicate_in_b' | 'price_out_of_tolerance'
 */
function reconcile(systemA, systemB, tolerance) {
  if (!Array.isArray(systemA) || !Array.isArray(systemB)) {
    throw new TypeError('systemA and systemB must be arrays');
  }
  const tol = toDecimal(tolerance, 'tolerance');
  if (tol.units < 0n) throw new RangeError('tolerance must be non-negative');

  // trade_id -> record, or DUPLICATE if it appears more than once in B.
  const DUPLICATE = Symbol('duplicate');
  const index = new Map();
  systemB.forEach((rec, i) => {
    const b = normalize(rec, `systemB[${i}]`);
    index.set(b.trade_id, index.has(b.trade_id) ? DUPLICATE : b);
  });

  const matched = [];
  const unmatched = [];
  systemA.forEach((rec, i) => {
    const a = normalize(rec, `systemA[${i}]`);
    const b = index.get(a.trade_id);
    if (b === undefined) {
      unmatched.push({ trade_id: a.trade_id, price_a: a.price, reason: 'missing_in_b' });
    } else if (b === DUPLICATE) {
      unmatched.push({ trade_id: a.trade_id, price_a: a.price, reason: 'duplicate_in_b' });
    } else if (!withinTolerance(a.decimal, b.decimal, tol)) {
      unmatched.push({ trade_id: a.trade_id, price_a: a.price, price_b: b.price, reason: 'price_out_of_tolerance' });
    } else {
      matched.push({ trade_id: a.trade_id, price_a: a.price, price_b: b.price });
    }
  });

  return { matched, unmatched };
}

module.exports = { reconcile, withinTolerance, toDecimal };
