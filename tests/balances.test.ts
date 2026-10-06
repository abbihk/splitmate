import assert from "node:assert/strict";
import test from "node:test";
import { calculateBalances, type BalanceExpense } from "../src/lib/balances";

const dinner: BalanceExpense = {
  currency: "PKR",
  amountMinor: 300000,
  payers: [{ userId: "abid", amountMinor: 300000 }],
  participants: ["abid", "ali", "ahmed"].map((userId) => ({ userId, amountOwedMinor: 100000 })),
};

test("a single payer is credited only after their personal share", () => {
  const [result] = calculateBalances([dinner], []);
  assert.deepEqual(result.balances, [{ userId: "abid", amountMinor: 200000 }, { userId: "ahmed", amountMinor: -100000 }, { userId: "ali", amountMinor: -100000 }]);
  assert.equal(result.recommendations.reduce((sum, debt) => sum + debt.amountMinor, 0), 200000);
});

test("partial and full repayments update both net balances and pair obligations", () => {
  const [partial] = calculateBalances([dinner], [{ currency: "PKR", fromUserId: "ali", toUserId: "abid", amountMinor: 40000 }]);
  assert.equal(partial.balances.find((row) => row.userId === "ali")?.amountMinor, -60000);
  assert.equal(partial.debts.find((row) => row.fromUserId === "ali")?.amountMinor, 60000);
  const [full] = calculateBalances([dinner], [
    { currency: "PKR", fromUserId: "ali", toUserId: "abid", amountMinor: 100000 },
    { currency: "PKR", fromUserId: "ahmed", toUserId: "abid", amountMinor: 100000 },
  ]);
  assert.ok(full.balances.every((row) => row.amountMinor === 0));
  assert.deepEqual(full.debts, []);
  assert.deepEqual(full.recommendations, []);
});

test("multiple payers account for contributions rather than treating the total as one payment", () => {
  const [result] = calculateBalances([{
    currency: "PKR", amountMinor: 500000,
    payers: [{ userId: "abid", amountMinor: 300000 }, { userId: "ali", amountMinor: 200000 }],
    participants: [{ userId: "abid", amountOwedMinor: 125000 }, { userId: "ali", amountOwedMinor: 125000 }, { userId: "sara", amountOwedMinor: 250000 }],
  }], []);
  assert.equal(result.balances.find((row) => row.userId === "abid")?.amountMinor, 175000);
  assert.equal(result.balances.find((row) => row.userId === "ali")?.amountMinor, 75000);
  assert.equal(result.balances.find((row) => row.userId === "sara")?.amountMinor, -250000);
  assert.equal(result.recommendations.reduce((sum, row) => sum + row.amountMinor, 0), 250000);
});

test("currency ledgers remain separate and opposing obligations cancel per pair", () => {
  const reverse: BalanceExpense = { currency: "PKR", amountMinor: 100000, payers: [{ userId: "ali", amountMinor: 100000 }], participants: [{ userId: "abid", amountOwedMinor: 100000 }] };
  const dollar: BalanceExpense = { ...reverse, currency: "USD" };
  const results = calculateBalances([dinner, reverse, dollar], []);
  assert.deepEqual(results.map((row) => row.currency), ["PKR", "USD"]);
  assert.equal(results[0].balances.find((row) => row.userId === "ali")?.amountMinor, 0);
  assert.ok(!results[0].debts.some((row) => row.fromUserId === "ali" || row.toUserId === "ali"));
  assert.equal(results[1].balances.find((row) => row.userId === "ali")?.amountMinor, 100000);
});

test("invalid financial records fail instead of producing silent balance drift", () => {
  assert.throws(() => calculateBalances([{ ...dinner, amountMinor: 200000 }], []));
  assert.throws(() => calculateBalances([{ ...dinner, payers: [{ userId: "abid", amountMinor: 299999 }] }], []));
  assert.throws(() => calculateBalances([dinner], [{ currency: "PKR", fromUserId: "ali", toUserId: "ali", amountMinor: 100 }]));
  assert.throws(() => calculateBalances([{ ...dinner, currency: "XYZ" }], []));
});

test("simplification keeps original obligations available while skipping intermediaries", () => {
  const [result] = calculateBalances([
    { currency: "PKR", amountMinor: 10000, payers: [{ userId: "b", amountMinor: 10000 }], participants: [{ userId: "a", amountOwedMinor: 10000 }] },
    { currency: "PKR", amountMinor: 10000, payers: [{ userId: "c", amountMinor: 10000 }], participants: [{ userId: "b", amountOwedMinor: 10000 }] },
  ], []);
  assert.deepEqual(result.debts, [
    { fromUserId: "a", toUserId: "b", amountMinor: 10000 },
    { fromUserId: "b", toUserId: "c", amountMinor: 10000 },
  ]);
  assert.deepEqual(result.recommendations, [{ fromUserId: "a", toUserId: "c", amountMinor: 10000 }]);
});
