const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcile } = require('./reconcile');

test('matches a unique trade within tolerance', () => {
  assert.deepEqual(reconcile([['T1', 100]], [['T1', 100.4]], 0.5), ['T1']);
});

test('output is sorted', () => {
  const a = [['T3', 1], ['T1', 1], ['T2', 1]];
  const b = [['T2', 1], ['T3', 1], ['T1', 1]];
  assert.deepEqual(reconcile(a, b, 0.5), ['T1', 'T2', 'T3']);
});

test('sorting is plain string order, not numeric or locale', () => {
  const a = [['T10', 1], ['T9', 1], ['b', 1], ['B', 1]];
  assert.deepEqual(reconcile(a, a, 0.5), ['B', 'T10', 'T9', 'b']);
});

test('trade_id missing in B is excluded', () => {
  assert.deepEqual(reconcile([['T1', 100]], [['T2', 100]], 1), []);
});

test('trade_ids only in B are simply absent from the output', () => {
  assert.deepEqual(reconcile([['T1', 5]], [['T1', 5], ['X', 1], ['Y', 2]], 1), ['T1']);
});

test('trade_id duplicated in B never matches, even with identical price', () => {
  assert.deepEqual(reconcile([['T1', 100]], [['T1', 100], ['T1', 100]], 1), []);
  assert.deepEqual(reconcile([['T1', 5]], [['T1', 5], ['T1', 5], ['T1', 5]], 1), []);
});

test('tolerance comparison is strict', () => {
  assert.deepEqual(reconcile([['T1', 100]], [['T1', 101]], 1), []);
});

test('negative and fractional prices', () => {
  const r = reconcile(
    [['N1', -10.25], ['N2', -0.5], ['N3', -1]],
    [['N1', -10.2], ['N2', 0.4], ['N3', 1]],
    0.1,
  );
  assert.deepEqual(r, ['N1']);
});

test('exact decimal comparison avoids floating point false positives', () => {
  // In floats Math.abs(0.3 - 0.2) === 0.09999999999999998 < 0.1.
  assert.deepEqual(reconcile([['T1', 0.3]], [['T1', 0.2]], 0.1), []);
  assert.deepEqual(reconcile([['T1', 0.3]], [['T1', 0.2000001]], 0.1), ['T1']);
});

test('accepts numeric strings and object records', () => {
  const r = reconcile(
    [{ trade_id: 'A', price: '1e2' }],
    [{ trade_id: 'A', price: '100.00001' }],
    '0.0001',
  );
  assert.deepEqual(r, ['A']);
});

test('trade_id matching is case-sensitive', () => {
  assert.deepEqual(reconcile([['abc', 1]], [['ABC', 1]], 1), []);
});

test('handles inputs near the 5,000 record limit', () => {
  const a = [];
  const b = [];
  for (let i = 0; i < 4999; i++) {
    a.push([`T${i}`, i * 0.01]);
    b.push([`T${i}`, i * 0.01 + (i % 2 ? 0.5 : 0.001)]);
  }
  const r = reconcile(a, b, 0.01);
  assert.equal(r.length, 2500);
  assert.ok(r.every((id) => Number(id.slice(1)) % 2 === 0));
});

test('rejects invalid input', () => {
  assert.throws(() => reconcile([], [], 0), RangeError);
  assert.throws(() => reconcile([], [], -1), RangeError);
  assert.throws(() => reconcile([['T 1', 1]], [], 1), TypeError);
  assert.throws(() => reconcile([['T1', NaN]], [], 1), TypeError);
  assert.throws(() => reconcile([['T1', 'abc']], [], 1), TypeError);
});
