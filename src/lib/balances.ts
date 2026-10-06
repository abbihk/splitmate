import { assertMinorUnits, isSupportedCurrency, MAX_EXPENSE_MINOR, safeMinorNumber, simplifyDebts, type Debt, type UserBalance } from "./money";

export type BalanceExpense = {
  currency: string;
  amountMinor?: number;
  paidByUserId?: string | null;
  payers: readonly { userId: string; amountMinor: number }[];
  participants: readonly { userId: string; amountOwedMinor: number }[];
};
export type BalanceSettlement = { currency: string; fromUserId: string; toUserId: string; amountMinor: number };
export type CurrencyBalance = {
  currency: string;
  balances: UserBalance[];
  /** Original per-expense obligations, offset by repayments and opposite obligations. */
  debts: Debt[];
  /** Optional simplification across all users in this currency. */
  recommendations: Debt[];
};

type CurrencyLedger = { positions: Map<string, bigint>; pairs: Map<string, { first: string; second: string; amount: bigint }> };

function addPosition(positions: Map<string, bigint>, userId: string, amount: bigint): void {
  if (!userId) throw new Error("A financial record is missing its user ID.");
  positions.set(userId, (positions.get(userId) ?? 0n) + amount);
}

function addDebt(ledger: CurrencyLedger, fromUserId: string, toUserId: string, amount: bigint): void {
  const [first, second] = [fromUserId, toUserId].sort();
  const key = JSON.stringify([first, second]);
  const previous = ledger.pairs.get(key)?.amount ?? 0n;
  ledger.pairs.set(key, { first, second, amount: previous + (fromUserId === first ? amount : -amount) });
}

/** Positive net means the user is owed money; currencies are always kept separate. */
export function calculateBalances(expenses: readonly BalanceExpense[], settlements: readonly BalanceSettlement[]): CurrencyBalance[] {
  const ledgers = new Map<string, CurrencyLedger>();
  const ledgerFor = (currency: string) => {
    if (!isSupportedCurrency(currency)) throw new Error("Unsupported currency in financial records.");
    let ledger = ledgers.get(currency);
    if (!ledger) {
      ledger = { positions: new Map(), pairs: new Map() };
      ledgers.set(currency, ledger);
    }
    return ledger;
  };
  for (const expense of expenses) {
    const ledger = ledgerFor(expense.currency);
    const expensePositions = new Map<string, bigint>();
    const payerIds = new Set<string>();
    const participantIds = new Set<string>();
    if (!expense.payers.length || !expense.participants.length) throw new Error("Expenses require payers and participants.");
    let paid = 0n;
    let owed = 0n;
    for (const payer of expense.payers) {
      assertMinorUnits(payer.amountMinor, "Payer amount");
      if (payer.amountMinor <= 0 || payerIds.has(payer.userId)) throw new Error("Expense payers must be unique with positive contributions.");
      payerIds.add(payer.userId);
      const amount = BigInt(payer.amountMinor);
      paid += amount;
      addPosition(expensePositions, payer.userId, amount);
    }
    for (const participant of expense.participants) {
      assertMinorUnits(participant.amountOwedMinor, "Participant amount");
      if (participantIds.has(participant.userId)) throw new Error("Expense participants must be unique.");
      participantIds.add(participant.userId);
      const amount = BigInt(participant.amountOwedMinor);
      owed += amount;
      addPosition(expensePositions, participant.userId, -amount);
    }
    if (paid !== owed || paid <= 0n || paid > BigInt(MAX_EXPENSE_MINOR)) throw new Error("Payer contributions and participant amounts must equal the expense total.");
    if (expense.amountMinor !== undefined) {
      assertMinorUnits(expense.amountMinor, "Expense total");
      if (BigInt(expense.amountMinor) !== paid) throw new Error("Expense total does not match its contributions.");
    }
    for (const [userId, amount] of expensePositions) addPosition(ledger.positions, userId, amount);
    const positions = [...expensePositions].map(([userId, amount]) => ({ userId, amountMinor: safeMinorNumber(amount) }));
    for (const debt of simplifyDebts(positions)) addDebt(ledger, debt.fromUserId, debt.toUserId, BigInt(debt.amountMinor));
  }
  for (const settlement of settlements) {
    assertMinorUnits(settlement.amountMinor, "Settlement amount");
    if (settlement.amountMinor <= 0 || settlement.amountMinor > MAX_EXPENSE_MINOR || settlement.fromUserId === settlement.toUserId) {
      throw new Error("Settlements require two different users and a positive supported amount.");
    }
    const ledger = ledgerFor(settlement.currency);
    const amount = BigInt(settlement.amountMinor);
    addPosition(ledger.positions, settlement.fromUserId, amount);
    addPosition(ledger.positions, settlement.toUserId, -amount);
    addDebt(ledger, settlement.fromUserId, settlement.toUserId, -amount);
  }
  return [...ledgers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([currency, ledger]) => {
    const balances = [...ledger.positions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([userId, amount]) => ({ userId, amountMinor: safeMinorNumber(amount) }));
    const debts = [...ledger.pairs.values()].filter((pair) => pair.amount !== 0n).map((pair) => ({
      fromUserId: pair.amount > 0n ? pair.first : pair.second,
      toUserId: pair.amount > 0n ? pair.second : pair.first,
      amountMinor: safeMinorNumber(pair.amount > 0n ? pair.amount : -pair.amount),
    })).sort((a, b) => a.fromUserId < b.fromUserId ? -1 : a.fromUserId > b.fromUserId ? 1 : a.toUserId < b.toUserId ? -1 : 1);
    return { currency, balances, debts, recommendations: simplifyDebts(balances) };
  });
}
