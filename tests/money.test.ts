import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, MAX_EXPENSE_MINOR, parseMoney, simplifyDebts, splitExpense } from "../src/lib/money";

test("decimal parsing preserves cents and rejects ambiguous or excessive precision", () => {
  assert.equal(parseMoney("0.29"), 29);
  assert.equal(parseMoney(" 3000.50 "), 300050);
  assert.equal(parseMoney("0001.1"), 110);
  assert.equal(parseMoney("10000000.00"), MAX_EXPENSE_MINOR);
  for (const input of ["1.001", "1e3", "-1", "NaN", "1,000", "", "10.000.00", "10000000.01"]) {
    assert.throws(() => parseMoney(input));
  }
});

test("money formatting preserves negative sub-unit values and currency", () => {
  assert.match(formatMoney(-1, "PKR"), /-.*PKR.*0\.01/);
  assert.match(formatMoney(123456, "USD"), /USD.*1,234\.56/);
  assert.throws(() => formatMoney(1.5, "PKR"));
  assert.throws(() => formatMoney(1, "XYZ"));
});

test("equal splits distribute cents deterministically without losing money", () => {
  const participants = [{ userId: "c" }, { userId: "a" }, { userId: "b" }];
  assert.deepEqual(splitExpense(100, "equal", participants), [
    { userId: "c", amountOwedMinor: 33 },
    { userId: "a", amountOwedMinor: 34 },
    { userId: "b", amountOwedMinor: 33 },
  ]);
  assert.deepEqual(splitExpense(2, "equal", participants).map((row) => row.amountOwedMinor), [0, 1, 1]);
});

test("exact splits reject imbalance and retain a zero participant share", () => {
  assert.deepEqual(splitExpense(200, "exact", [{ userId: "a", value: 0 }, { userId: "b", value: 200 }]), [
    { userId: "a", amountOwedMinor: 0 },
    { userId: "b", amountOwedMinor: 200 },
  ]);
  assert.throws(() => splitExpense(200, "exact", [{ userId: "a", value: 201 }]));
  assert.throws(() => splitExpense(200, "exact", [{ userId: "a", value: 199.5 }]));
});

test("basis point percentages allocate largest remainders with no float multiplication", () => {
  const rows = splitExpense(101, "percentage", [{ userId: "a", value: 2000 }, { userId: "b", value: 3000 }, { userId: "c", value: 5000 }]);
  assert.deepEqual(rows.map((row) => row.amountOwedMinor), [20, 30, 51]);
  assert.equal(rows[0].percentage, 2000);
  assert.throws(() => splitExpense(100, "percentage", [{ userId: "a", value: 9999 }]));
});

test("share splits conserve total over many amounts and uneven integer weights", () => {
  const participants = [{ userId: "a", value: 1 }, { userId: "b", value: 3 }, { userId: "c", value: 7 }];
  for (let total = 1; total < 250; total += 1) {
    const rows = splitExpense(total, "shares", participants);
    assert.equal(rows.reduce((sum, row) => sum + row.amountOwedMinor, 0), total);
    for (const row of rows) assert.ok(Number.isInteger(row.amountOwedMinor) && row.amountOwedMinor >= 0);
    const reversed = splitExpense(total, "shares", [...participants].reverse());
    assert.deepEqual(new Map(rows.map((row) => [row.userId, row.amountOwedMinor])), new Map(reversed.map((row) => [row.userId, row.amountOwedMinor])));
  }
  assert.throws(() => splitExpense(100, "shares", [{ userId: "a", value: 0 }]));
  assert.throws(() => splitExpense(100, "shares", [{ userId: "a", value: 0.5 }]));
});

test("split validation rejects duplicate users, zero expenses, and unsafe integers", () => {
  assert.throws(() => splitExpense(100, "equal", [{ userId: "a" }, { userId: "a" }]));
  assert.throws(() => splitExpense(0, "equal", [{ userId: "a" }]));
  assert.throws(() => splitExpense(Number.MAX_SAFE_INTEGER + 1, "equal", [{ userId: "a" }]));
  assert.throws(() => splitExpense(100, "equal", []));
});

test("simplification removes intermediaries and exactly clears every net position", () => {
  assert.deepEqual(simplifyDebts([{ userId: "a", amountMinor: -100 }, { userId: "b", amountMinor: 0 }, { userId: "c", amountMinor: 100 }]), [
    { fromUserId: "a", toUserId: "c", amountMinor: 100 },
  ]);
  const balances = [{ userId: "a", amountMinor: -1234 }, { userId: "b", amountMinor: -567 }, { userId: "c", amountMinor: 1000 }, { userId: "d", amountMinor: 801 }];
  const suggestions = simplifyDebts(balances);
  const remainder = new Map(balances.map((row) => [row.userId, row.amountMinor]));
  for (const transfer of suggestions) {
    assert.ok(transfer.amountMinor > 0);
    remainder.set(transfer.fromUserId, remainder.get(transfer.fromUserId)! + transfer.amountMinor);
    remainder.set(transfer.toUserId, remainder.get(transfer.toUserId)! - transfer.amountMinor);
  }
  assert.deepEqual([...remainder.values()], [0, 0, 0, 0]);
  assert.deepEqual(simplifyDebts([]), []);
  assert.throws(() => simplifyDebts([{ userId: "a", amountMinor: 1 }]));
});
