const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('./reconcile');

const ids = (list) => list.map((r) => r.trade_id);

test('matches a unique trade within tolerance', () => {
  const r = reconcile([['T1', 100]], [['T1', 100.4]], 0.5);
  assert.deepEqual(ids(r.matched), ['T1']);
  assert.deepEqual(r.unmatched, []);
});

test('missing trade_id in B does not match', () => {
  const r = reconcile([['T1', 100]], [['T2', 100]], 1);
  assert.equal(r.unmatched[0].reason, 'missing_in_b');
});

test('trade_id duplicated in B never matches, even with identical price', () => {
  const r = reconcile([['T1', 100]], [['T1', 100], ['T1', 100]], 1);
  assert.deepEqual(r.matched, []);
  assert.equal(r.unmatched[0].reason, 'duplicate_in_b');
});

test('duplicate in B stays a duplicate even if repeated three times', () => {
  const r = reconcile([['T1', 5]], [['T1', 5], ['T1', 5], ['T1', 5]], 1);
  assert.equal(r.unmatched[0].reason, 'duplicate_in_b');
});

test('tolerance comparison is strict', () => {
  const r = reconcile([['T1', 100]], [['T1', 101]], 1);
  assert.equal(r.unmatched[0].reason, 'price_out_of_tolerance');
});

test('zero tolerance can never match (|diff| < 0 is impossible)', () => {
  const r = reconcile([['T1', 7]], [['T1', 7]], 0);
  assert.equal(r.unmatched[0].reason, 'price_out_of_tolerance');
});

test('negative and fractional prices', () => {
  const r = reconcile(
    [['N1', -10.25], ['N2', -0.5], ['N3', -1]],
    [['N1', -10.2], ['N2', 0.4], ['N3', 1]],
    0.1,
  );
  assert.deepEqual(ids(r.matched), ['N1']);
  assert.deepEqual(ids(r.unmatched), ['N2', 'N3']);
});

test('exact decimal comparison avoids floating point false positives', () => {
  // In floats Math.abs(0.3 - 0.2) === 0.09999999999999998 < 0.1.
  const r = reconcile([['T1', 0.3]], [['T1', 0.2]], 0.1);
  assert.equal(r.unmatched[0].reason, 'price_out_of_tolerance');
  // ...and genuinely close values still match.
  const r2 = reconcile([['T1', 0.3]], [['T1', 0.2000001]], 0.1);
  assert.deepEqual(ids(r2.matched), ['T1']);
});

test('accepts numeric strings and object records', () => {
  const r = reconcile(
    [{ trade_id: 'A', price: '1e2' }],
    [{ trade_id: 'A', price: '100.00001' }],
    '0.0001',
  );
  assert.deepEqual(ids(r.matched), ['A']);
});

test('trade_id matching is exact (case-sensitive)', () => {
  const r = reconcile([['abc', 1]], [['ABC', 1]], 1);
  assert.equal(r.unmatched[0].reason, 'missing_in_b');
});

test('each A record is judged independently, including repeats in A', () => {
  const r = reconcile([['T1', 10], ['T1', 50]], [['T1', 10.5]], 1);
  assert.deepEqual(r.matched.map((m) => m.price_a), [10]);
  assert.deepEqual(r.unmatched.map((m) => m.price_a), [50]);
});

test('empty inputs', () => {
  assert.deepEqual(reconcile([], [], 1), { matched: [], unmatched: [] });
  assert.deepEqual(reconcile([['T1', 1]], [], 1).unmatched[0].reason, 'missing_in_b');
});

test('rejects invalid input', () => {
  assert.throws(() => reconcile([], [], -1), RangeError);
  assert.throws(() => reconcile([['T 1', 1]], [], 1), TypeError);
  assert.throws(() => reconcile([['T1', NaN]], [], 1), TypeError);
  assert.throws(() => reconcile([['T1', 'abc']], [], 1), TypeError);
});
