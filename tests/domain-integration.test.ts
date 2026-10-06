import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.INTEGRATION_URL?.replace(/\/$/, "");
type Account = { id: string; email: string; cookie: string };
type ApiResponse = { status: number; body: any; cookie: string };
async function api(path: string, account?: Account, method = "GET", body?: unknown): Promise<ApiResponse> {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(account ? { Cookie: account.cookie } : {}), ...(method !== "GET" ? { Origin: new URL(base!).origin, "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${method} ${path}: non-JSON response ${response.status}: ${text.slice(0, 200)}`); }
  return { status: response.status, body: parsed, cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}
function success(result: ApiResponse, expected = 200): any {
  assert.equal(result.status, expected, JSON.stringify(result.body));
  return result.body.data;
}
async function register(name: string, run: string): Promise<Account> {
  const email = `${name.toLowerCase()}-${run}@integration.splitmate.test`;
  const result = await api("/api/auth/register", undefined, "POST", { name: `Test ${name}`, email, password: "DomainTest123!", confirmPassword: "DomainTest123!" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.ok(result.cookie);
  return { id: result.body.user.id, email, cookie: result.cookie };
}
async function connect(first: Account, second: Account) {
  const request = success(await api("/api/friends/request", first, "POST", { receiverId: second.id }), 201);
  success(await api(`/api/friends/${request.id}/accept`, second, "PATCH"));
  return request.id as string;
}

test("domain API preserves exact split ledgers, currency scopes, and server authorization", { skip: !base, timeout: 180000 }, async (t) => {
  const run = randomUUID().slice(0, 8);
  const owner = await register("Owner", run);
  const friend = await register("Friend", run);
  const third = await register("Third", run);
  const outsider = await register("Outsider", run);
  const friendId = await connect(owner, friend);
  await connect(owner, third);
  const date = new Date().toISOString().slice(0, 10);
  const group = success(await api("/api/groups", owner, "POST", { name: `API trip ${run}`, groupType: "trip", defaultCurrency: "USD", memberIds: [friend.id, third.id] }), 201);
  let usdExpense: any;
  const makeExpense = (overrides: Record<string, unknown> = {}) => ({ title: "Multiple payer dinner", amount: "120.00", currency: "USD", expenseDate: date, category: "food", groupId: group.id, splitType: "equal", participants: [{ userId: owner.id }, { userId: friend.id }, { userId: third.id }], payers: [{ userId: owner.id, amount: "90.00" }, { userId: friend.id, amount: "30.00" }], ...overrides });

  await t.test("public profiles, friends, group ownership, and partial updates", async () => {
    const relationships = success(await api("/api/friends", owner));
    assert.equal(relationships.filter((entry: any) => entry.status === "accepted").length, 2);
    assert.equal(relationships.find((entry: any) => entry.id === friendId).user.id, friend.id);
    assert.equal(JSON.stringify(relationships).includes("passwordHash"), false);
    const found = success(await api(`/api/users?q=${encodeURIComponent(friend.email)}`, owner));
    assert.equal(found[0].id, friend.id);
    assert.equal("passwordHash" in found[0], false);
    assert.equal((await api(`/api/friends/${owner.id}`, owner)).status, 404);
    assert.equal((await api(`/api/groups/${group.id}`, outsider)).status, 404);
    assert.equal((await api(`/api/groups/${group.id}`, friend, "PATCH", { name: "Unauthorized" })).status, 403);
    const changed = success(await api(`/api/groups/${group.id}`, owner, "PATCH", { name: `Renamed trip ${run}` }));
    assert.equal(changed.defaultCurrency, "USD");
    assert.equal(changed.groupType, "trip");
    assert.equal((await api(`/api/groups/${group.id}/members/${owner.id}`, owner, "DELETE")).status, 400);
  });
  await t.test("all four methods and multiple payers allocate every cent", async () => {
    usdExpense = success(await api("/api/expenses", owner, "POST", makeExpense()), 201);
    assert.equal(usdExpense.payers.length, 2);
    assert.equal(usdExpense.participants.reduce((sum: number, person: any) => sum + person.amountOwedMinor, 0), 12000);
    const amounts = [
      { currency: "PKR", amount: "99.99", splitType: "equal", participants: [{ userId: owner.id }, { userId: friend.id }, { userId: third.id }] },
      { currency: "EUR", amount: "10.01", splitType: "percentage", participants: [{ userId: owner.id, value: "50" }, { userId: friend.id, value: "30" }, { userId: third.id, value: "20" }] },
      { currency: "GBP", amount: "100.00", splitType: "shares", participants: [{ userId: owner.id, value: "1" }, { userId: friend.id, value: "1" }, { userId: third.id, value: "2" }] },
      { currency: "AED", amount: "6.00", splitType: "exact", participants: [{ userId: owner.id, value: "1" }, { userId: friend.id, value: "2" }, { userId: third.id, value: "3" }] },
    ];
    for (const values of amounts) {
      // Personal expenses keep the member-removal test confined to the USD group balance.
      const expense = success(await api("/api/expenses", owner, "POST", makeExpense({ ...values, title: `Split ${values.splitType}`, groupId: null, payers: [{ userId: owner.id, amount: values.amount }] })), 201);
      assert.equal(expense.participants.reduce((sum: number, person: any) => sum + person.amountOwedMinor, 0), expense.amountMinor);
    }
    const ledger = success(await api(`/api/groups/${group.id}/balances`, owner));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].currency, "USD");
    assert.equal(ledger[0].balances.find((entry: any) => entry.userId === owner.id).amountMinor, 5000);
    assert.equal(ledger[0].balances.find((entry: any) => entry.userId === friend.id).amountMinor, -1000);
    assert.equal(ledger[0].balances.find((entry: any) => entry.userId === third.id).amountMinor, -4000);
    const balances = success(await api("/api/balances", owner));
    assert.ok(balances.currencies.some((entry: any) => entry.currency === "PKR"));
    assert.ok(balances.currencies.some((entry: any) => entry.currency === "USD"));
    assert.ok(balances.recommendations.every((entry: any) => entry.currency && Object.hasOwn(entry, "groupId")));
  });
  await t.test("bad financial input and foreign accounts are rejected", async () => {
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense({ payers: [{ userId: owner.id, amount: "119.99" }] }))).status, 400);
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense({ participants: [{ userId: owner.id }, { userId: owner.id }] }))).status, 400);
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense({ splitType: "percentage", participants: [{ userId: owner.id, value: "99" }] }))).status, 400);
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense({ splitType: "shares", participants: [{ userId: owner.id, value: "0" }] }))).status, 400);
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense({ participants: [{ userId: outsider.id }] }))).status, 400);
    assert.equal((await api("/api/expenses", friend, "POST", makeExpense({ groupId: null, participants: [{ userId: friend.id }, { userId: third.id }] }))).status, 400);
    assert.equal((await api(`/api/expenses/${usdExpense.id}`, outsider)).status, 404);
    assert.equal((await api(`/api/expenses/${usdExpense.id}`, outsider, "DELETE")).status, 404);
    assert.equal((await api(`/api/expenses/${usdExpense.id}`, friend, "PATCH", makeExpense())).status, 403);
    assert.equal((await api(`/api/groups/${group.id}/members/${third.id}`, owner, "DELETE")).status, 409);
    const foreignExpenses = success(await api(`/api/expenses?q=${run}`, outsider));
    assert.equal(foreignExpenses.length, 0);
    const search = success(await api(`/api/search?q=${run}`, outsider));
    assert.equal(search.groups.length, 0);
  });
  await t.test("repayments enforce direction, scope, and concurrent outstanding limits", async () => {
    const payment = (amount: string) => ({ fromUserId: third.id, toUserId: owner.id, amount, currency: "USD", groupId: group.id, paymentMethod: "bank_transfer", settlementDate: date });
    assert.equal((await api("/api/settlements", owner, "POST", payment("40.01"))).status, 400);
    assert.equal((await api("/api/settlements", outsider, "POST", payment("1.00"))).status, 403);
    assert.equal((await api("/api/settlements", owner, "POST", { ...payment("1.00"), currency: "CAD" })).status, 400);
    success(await api("/api/settlements", third, "POST", payment("15.00")), 201);
    const concurrent = await Promise.all([api("/api/settlements", third, "POST", payment("20.00")), api("/api/settlements", third, "POST", payment("20.00"))]);
    assert.equal(concurrent.filter((entry) => entry.status === 201).length, 1, JSON.stringify(concurrent));
    assert.ok(concurrent.some((entry) => [400, 409].includes(entry.status)));
    const ledger = success(await api(`/api/groups/${group.id}/balances`, owner));
    assert.equal(ledger[0].balances.find((entry: any) => entry.userId === third.id).amountMinor, -500);
    success(await api("/api/settlements", third, "POST", payment("5.00")), 201);
    success(await api(`/api/groups/${group.id}/members/${third.id}`, owner, "DELETE"));
    assert.equal((await api(`/api/groups/${group.id}`, third)).status, 404);
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense())).status, 400);
  });
  await t.test("shared private debts can be repaid by participants without mutual friendship", async () => {
    const expense = success(await api("/api/expenses", owner, "POST", makeExpense({ title: "Friend payer", amount: "12.00", groupId: null, splitType: "exact", payers: [{ userId: friend.id, amount: "12.00" }], participants: [{ userId: owner.id, value: "0" }, { userId: friend.id, value: "6.00" }, { userId: third.id, value: "6.00" }] })), 201);
    assert.equal((await api(`/api/expenses/${expense.id}`, outsider)).status, 404);
    success(await api(`/api/expenses/${expense.id}`, third));
    success(await api("/api/profile", friend, "PATCH", { notificationPrefs: { friendRequests: true, groupActivity: true, expenses: true, payments: false } }));
    const before = (await api("/api/notifications", friend)).body.data.filter((entry: any) => entry.type === "payment_recorded").length;
    success(await api("/api/settlements", third, "POST", { fromUserId: third.id, toUserId: friend.id, amount: "6.00", currency: "USD", paymentMethod: "cash", settlementDate: date }), 201);
    const after = (await api("/api/notifications", friend)).body.data.filter((entry: any) => entry.type === "payment_recorded").length;
    assert.equal(after, before);
    assert.equal((await api("/api/settlements", third, "POST", { fromUserId: third.id, toUserId: friend.id, amount: "0.01", currency: "USD", paymentMethod: "cash", settlementDate: date })).status, 400);
  });
  await t.test("expense edits and deletes create scoped history and update the ledger", async () => {
    const disposable = success(await api("/api/expenses", owner, "POST", makeExpense({ title: `Disposable ${run}`, groupId: null, amount: "4.00", participants: [{ userId: owner.id }, { userId: friend.id }], payers: [{ userId: owner.id, amount: "4.00" }] })), 201);
    const updated = success(await api(`/api/expenses/${disposable.id}`, owner, "PATCH", makeExpense({ title: `Edited ${run}`, groupId: null, amount: "6.00", participants: [{ userId: owner.id }, { userId: friend.id }], payers: [{ userId: owner.id, amount: "6.00" }] })));
    assert.equal(updated.amountMinor, 600);
    success(await api(`/api/expenses/${disposable.id}`, owner, "DELETE"));
    assert.equal((await api(`/api/expenses/${disposable.id}`, owner)).status, 404);
    const activities = (await api("/api/activity?pageSize=100", friend)).body.data;
    assert.ok(activities.some((entry: any) => entry.type === "expense_deleted" && entry.metadata.deletedExpenseId === disposable.id));
    const outsidersActivities = (await api("/api/activity?pageSize=100", outsider)).body.data;
    assert.equal(outsidersActivities.length, 0);
    const notifications = (await api("/api/notifications", friend)).body;
    assert.ok(notifications.unreadCount > 0);
    success(await api(`/api/notifications/${notifications.data[0].id}/read`, friend, "PATCH"));
    assert.equal((await api(`/api/notifications/${notifications.data[0].id}/read`, outsider, "PATCH")).status, 404);
    success(await api("/api/notifications/read-all", friend, "PATCH"));
    assert.equal((await api("/api/notifications", friend)).body.unreadCount, 0);
    const overview = success(await api("/api/dashboard", owner));
    assert.ok(overview.monthlySpending.every((entry: any) => Number.isSafeInteger(entry.amountMinor) && entry.currency));
    assert.ok(overview.categorySpending.every((entry: any) => Number.isSafeInteger(entry.amountMinor) && entry.currency));
    assert.equal("passwordHash" in overview.user, false);
  });
  await t.test("archival preserves readable history and permits outstanding repayments", async () => {
    success(await api(`/api/groups/${group.id}`, owner, "DELETE"));
    assert.equal(success(await api(`/api/groups/${group.id}`, owner)).archived, true);
    assert.equal((await api("/api/expenses", owner, "POST", makeExpense({ participants: [{ userId: owner.id }, { userId: friend.id }] }))).status, 409);
    success(await api("/api/settlements", friend, "POST", { fromUserId: friend.id, toUserId: owner.id, amount: "10.00", currency: "USD", groupId: group.id, settlementDate: date, paymentMethod: "cash" }), 201);
    success(await api(`/api/groups/${group.id}`, owner, "PATCH", { archived: false }));
  });
});
