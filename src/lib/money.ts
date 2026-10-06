/** All supported currencies use two decimal places. Money travels as integer minor units. */
export const SUPPORTED_CURRENCIES = ["PKR", "USD", "EUR", "GBP", "AED", "SAR", "INR", "CAD", "AUD"] as const;
export const MAX_EXPENSE_MINOR = 1_000_000_000;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export type SplitType = "equal" | "exact" | "percentage" | "shares";
export type SplitInput = { userId: string; value?: number };
export type ExpenseSplit = { userId: string; amountOwedMinor: number; percentage?: number; shares?: number };
export type UserBalance = { userId: string; amountMinor: number };
export type Debt = { fromUserId: string; toUserId: string; amountMinor: number };

export function isSupportedCurrency(currency: string): currency is Currency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}

export function assertMinorUnits(value: number, label = "Amount", allowNegative = false): void {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new Error(`${label} must be a ${allowNegative ? "safe" : "non-negative safe"} integer in minor units.`);
  }
}

export function safeMinorNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error("The combined balance is too large to represent safely.");
  }
  return Number(value);
}

/** Parse decimal text without binary floating point, currency symbols, or ambiguous grouping. */
export function parseMoney(input: string): number {
  const text = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || text.length > 20) {
    throw new Error("Enter a valid amount with no more than two decimal places.");
  }
  const [whole, fraction = ""] = text.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > BigInt(MAX_EXPENSE_MINOR)) throw new Error("Amount cannot exceed 10,000,000.00.");
  return Number(minor);
}

/** Format integer cents directly; Intl handles grouping/signs while the cents remain exact. */
export function formatMoney(amountMinor: number, currency: string): string {
  assertMinorUnits(amountMinor, "Amount", true);
  if (!isSupportedCurrency(currency)) throw new Error("Unsupported currency.");
  const signed = BigInt(amountMinor);
  const absolute = signed < 0n ? -signed : signed;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  const formatter = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Negative zero preserves the minus sign for amounts between -0.99 and -0.01.
  const displayWhole = signed < 0n ? (whole === 0n ? -0 : -whole) : whole;
  return formatter.formatToParts(displayWhole).map((part) => (part.type === "fraction" ? fraction : part.value)).join("");
}

function validateParticipants(participants: readonly SplitInput[]): void {
  if (!participants.length || participants.length > 200) throw new Error("Choose between 1 and 200 participants.");
  const ids = new Set<string>();
  for (const participant of participants) {
    if (!participant.userId || ids.has(participant.userId)) throw new Error("Participants must have unique user IDs.");
    ids.add(participant.userId);
  }
}

/** Largest-remainder allocation distributes every cent, with a stable user-ID tie break. */
function allocate(total: bigint, participants: readonly SplitInput[], weights: bigint[]): number[] {
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  if (denominator <= 0n) throw new Error("Split weights must total more than zero.");
  const rows = weights.map((weight, index) => ({
    index,
    userId: participants[index].userId,
    amount: (total * weight) / denominator,
    remainder: (total * weight) % denominator,
  }));
  let leftover = total - rows.reduce((sum, row) => sum + row.amount, 0n);
  const ranked = [...rows].sort((a, b) => a.remainder === b.remainder ? compareIds(a.userId, b.userId) : a.remainder > b.remainder ? -1 : 1);
  for (const row of ranked) {
    if (leftover === 0n) break;
    row.amount += 1n;
    leftover -= 1n;
  }
  return rows.map((row) => safeMinorNumber(row.amount));
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Exact values are minor units; percentages are basis points (100% = 10,000); shares are integers. */
export function splitExpense(totalMinor: number, splitType: SplitType, participants: readonly SplitInput[]): ExpenseSplit[] {
  assertMinorUnits(totalMinor);
  if (totalMinor <= 0 || totalMinor > MAX_EXPENSE_MINOR) throw new Error("Expense amount must be positive and at most 10,000,000.00.");
  validateParticipants(participants);
  const total = BigInt(totalMinor);
  let amounts: number[];
  switch (splitType) {
    case "equal":
      amounts = allocate(total, participants, participants.map(() => 1n));
      break;
    case "exact": {
      const values = participants.map((participant) => {
        assertMinorUnits(participant.value ?? NaN, "Each exact amount");
        return BigInt(participant.value!);
      });
      if (values.reduce((sum, value) => sum + value, 0n) !== total) throw new Error("Exact amounts must add up to the expense total.");
      amounts = values.map(safeMinorNumber);
      break;
    }
    case "percentage": {
      const values = participants.map((participant) => {
        assertMinorUnits(participant.value ?? NaN, "Each percentage in basis points");
        if (participant.value! > 10_000) throw new Error("Each percentage must be between 0 and 100%.");
        return BigInt(participant.value!);
      });
      if (values.reduce((sum, value) => sum + value, 0n) !== 10_000n) throw new Error("Percentages must add up to 100%.");
      amounts = allocate(total, participants, values);
      break;
    }
    case "shares": {
      const values = participants.map((participant) => {
        assertMinorUnits(participant.value ?? NaN, "Each share count");
        if (participant.value! <= 0 || participant.value! > 1_000_000) throw new Error("Shares must be whole numbers from 1 to 1,000,000.");
        return BigInt(participant.value!);
      });
      amounts = allocate(total, participants, values);
      break;
    }
    default:
      throw new Error("Choose a supported split method.");
  }
  return participants.map((participant, index) => ({
    userId: participant.userId,
    amountOwedMinor: amounts[index],
    ...(splitType === "percentage" ? { percentage: participant.value } : {}),
    ...(splitType === "shares" ? { shares: participant.value } : {}),
  }));
}

/** Suggest repayments from negative (owes) to positive (is owed) positions. Original records never change. */
export function simplifyDebts(balances: readonly UserBalance[]): Debt[] {
  const seen = new Set<string>();
  const positions = balances.map((balance) => {
    if (!balance.userId || seen.has(balance.userId)) throw new Error("Balance user IDs must be unique.");
    seen.add(balance.userId);
    assertMinorUnits(balance.amountMinor, "Balance", true);
    return { userId: balance.userId, amount: BigInt(balance.amountMinor) };
  });
  if (positions.reduce((sum, row) => sum + row.amount, 0n) !== 0n) throw new Error("Balances must sum to zero before simplifying debts.");
  const debtors = positions.filter((row) => row.amount < 0n).map((row) => ({ ...row, amount: -row.amount }));
  const creditors = positions.filter((row) => row.amount > 0n);
  const sortByAmount = (a: { userId: string; amount: bigint }, b: { userId: string; amount: bigint }) =>
    a.amount === b.amount ? compareIds(a.userId, b.userId) : a.amount > b.amount ? -1 : 1;
  debtors.sort(sortByAmount);
  creditors.sort(sortByAmount);
  const result: Debt[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
    result.push({ fromUserId: debtor.userId, toUserId: creditor.userId, amountMinor: safeMinorNumber(amount) });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0n) debtorIndex += 1;
    if (creditor.amount === 0n) creditorIndex += 1;
  }
  return result;
}
