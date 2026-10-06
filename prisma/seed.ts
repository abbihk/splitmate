import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { splitExpense, type SplitType } from "../src/lib/money";

const prisma = new PrismaClient();

/** Sample accounts are created only by explicitly running npm run db:seed. */
async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SAMPLE_SEED !== "true") {
    throw new Error("Sample seeding is disabled in production. Use a development database.");
  }
  const now = new Date();
  const daysAgo = (days: number) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - days);
    date.setUTCHours(12, 0, 0, 0);
    return date;
  };
  const users = await Promise.all([
    { id: "seed_user_abid", name: "Abid Abbi", email: "demo@splitmate.local" },
    { id: "seed_user_ali", name: "Ali Hassan", email: "ali@splitmate.local" },
    { id: "seed_user_sara", name: "Sara Khan", email: "sara@splitmate.local" },
    { id: "seed_user_ahmed", name: "Ahmed Raza", email: "ahmed@splitmate.local" },
  ].map(async (user) => prisma.user.upsert({
    where: { email: user.email },
    update: {},
    create: { ...user, passwordHash: await hash("SplitMate2026!", 12), defaultCurrency: "PKR", timezone: "Asia/Karachi" },
  })));
  const [abid, ali, sara, ahmed] = users;
  const ids = { abid: abid.id, ali: ali.id, sara: sara.id, ahmed: ahmed.id };
  type Person = keyof typeof ids;

  await prisma.$transaction(async (tx) => {
    for (let first = 0; first < users.length; first += 1) {
      for (let second = first + 1; second < users.length; second += 1) {
        const pairKey = [users[first].id, users[second].id].sort().join(":");
        await tx.friendship.upsert({ where: { pairKey }, update: {}, create: {
          requesterId: users[first].id, receiverId: users[second].id, pairKey, status: "accepted", createdAt: daysAgo(50),
        } });
      }
    }

    const groups = [
      { id: "seed_group_northern", name: "Northern escape", description: "Mountains, long drives, and good company. Our next adventure together.", groupType: "trip", icon: "mountain", members: ["abid", "ali", "sara", "ahmed"] as Person[] },
      { id: "seed_group_apartment", name: "Apartment 4B", description: "Keeping our home expenses simple, from rent to the weekly groceries.", groupType: "home", icon: "home", members: ["abid", "ali", "sara"] as Person[] },
      { id: "seed_group_friday", name: "Friday table", description: "Our regular catch-up over good food. Everyone gets a turn to pick the place.", groupType: "dinner", icon: "utensils", members: ["abid", "ali", "sara", "ahmed"] as Person[] },
    ];
    for (const group of groups) {
      await tx.group.upsert({ where: { id: group.id }, update: {}, create: {
        id: group.id, name: group.name, description: group.description, groupType: group.groupType,
        icon: group.icon, createdById: abid.id, defaultCurrency: "PKR", createdAt: daysAgo(45),
      } });
      for (const person of group.members) {
        await tx.groupMember.upsert({ where: { groupId_userId: { groupId: group.id, userId: ids[person] } }, update: {}, create: {
          groupId: group.id, userId: ids[person], role: person === "abid" ? "owner" : person === "ali" ? "admin" : "member", joinedAt: daysAgo(45),
        } });
      }
    }

    const expenses: { id: string; title: string; amountMinor: number; groupId?: string; category: string; days: number; payers: { person: Person; amountMinor: number }[]; participants: Person[]; splitType?: SplitType; values?: number[]; description?: string }[] = [
      { id: "seed_expense_hotel", title: "Mountain cabin booking", amountMinor: 2800000, groupId: groups[0].id, category: "hotel", days: 2, payers: [{ person: "abid", amountMinor: 2800000 }], participants: ["abid", "ali", "sara", "ahmed"], description: "Two nights in Nathiagali, including breakfast." },
      { id: "seed_expense_fuel", title: "Fuel for the road trip", amountMinor: 680000, groupId: groups[0].id, category: "fuel", days: 3, payers: [{ person: "ali", amountMinor: 680000 }], participants: ["abid", "ali", "sara", "ahmed"] },
      { id: "seed_expense_breakfast", title: "Breakfast on the way", amountMinor: 420000, groupId: groups[0].id, category: "food", days: 4, payers: [{ person: "sara", amountMinor: 420000 }], participants: ["abid", "ali", "sara", "ahmed"] },
      { id: "seed_expense_rent", title: "This month's rent", amountMinor: 7500000, groupId: groups[1].id, category: "rent", days: 1, payers: [{ person: "abid", amountMinor: 4500000 }, { person: "ali", amountMinor: 3000000 }], participants: ["abid", "ali", "sara"], splitType: "shares", values: [2, 2, 1], description: "Shared rent, with the smaller room counted as one share." },
      { id: "seed_expense_groceries", title: "Weekly groceries", amountMinor: 1245000, groupId: groups[1].id, category: "groceries", days: 2, payers: [{ person: "sara", amountMinor: 1245000 }], participants: ["abid", "ali", "sara"] },
      { id: "seed_expense_internet", title: "Internet subscription", amountMinor: 480000, groupId: groups[1].id, category: "utilities", days: 5, payers: [{ person: "ali", amountMinor: 480000 }], participants: ["abid", "ali", "sara"] },
      { id: "seed_expense_dinner", title: "Dinner at the courtyard", amountMinor: 960000, groupId: groups[2].id, category: "food", days: 1, payers: [{ person: "abid", amountMinor: 960000 }], participants: ["abid", "ali", "sara", "ahmed"] },
      { id: "seed_expense_cinema", title: "Movie night tickets", amountMinor: 600000, groupId: groups[2].id, category: "entertainment", days: 8, payers: [{ person: "ahmed", amountMinor: 600000 }], participants: ["abid", "ali", "sara", "ahmed"] },
      { id: "seed_expense_cafe", title: "Coffee and catch-up", amountMinor: 345000, category: "food", days: 3, payers: [{ person: "abid", amountMinor: 345000 }], participants: ["abid", "ali", "sara"], splitType: "percentage", values: [4000, 3000, 3000] },
      { id: "seed_expense_books", title: "Shared course materials", amountMinor: 180000, category: "education", days: 16, payers: [{ person: "ali", amountMinor: 180000 }], participants: ["abid", "ali"], splitType: "exact", values: [80000, 100000] },
      { id: "seed_expense_previous_groceries", title: "Last month's groceries", amountMinor: 1080000, groupId: groups[1].id, category: "groceries", days: 34, payers: [{ person: "abid", amountMinor: 1080000 }], participants: ["abid", "ali", "sara"] },
      { id: "seed_expense_previous_dinner", title: "Team dinner", amountMinor: 820000, groupId: groups[2].id, category: "food", days: 65, payers: [{ person: "sara", amountMinor: 820000 }], participants: ["abid", "ali", "sara", "ahmed"] },
    ];
    for (const expense of expenses) {
      const splitType = expense.splitType ?? "equal";
      const splits = splitExpense(expense.amountMinor, splitType, expense.participants.map((person, index) => ({ userId: ids[person], value: expense.values?.[index] })));
      const createdById = ids[expense.payers[0].person];
      await tx.expense.upsert({ where: { id: expense.id }, update: {}, create: {
        id: expense.id, title: expense.title, description: expense.description, amountMinor: expense.amountMinor,
        currency: "PKR", category: expense.category, groupId: expense.groupId, splitType,
        createdByUserId: createdById, paidByUserId: expense.payers.length === 1 ? createdById : null,
        expenseDate: daysAgo(expense.days), createdAt: daysAgo(expense.days),
        payers: { create: expense.payers.map((payer) => ({ userId: ids[payer.person], amountMinor: payer.amountMinor })) },
        participants: { create: splits },
      } });
      await tx.activity.upsert({ where: { id: `${expense.id}_activity` }, update: {}, create: {
        id: `${expense.id}_activity`, type: "expense.created", actorId: createdById,
        groupId: expense.groupId, expenseId: expense.id, createdAt: daysAgo(expense.days),
        metadata: { title: expense.title, amountMinor: expense.amountMinor, currency: "PKR" },
        recipients: { create: [...new Set([...expense.participants.map((person) => ids[person]), ...expense.payers.map((payer) => ids[payer.person])])].map((userId) => ({ userId })) },
      } });
    }
    const payments = [
      { id: "seed_settlement_trip", fromUserId: ahmed.id, toUserId: abid.id, groupId: groups[0].id, amountMinor: 250000, method: "bank_transfer", days: 1, note: "Part of my cabin share." },
      { id: "seed_settlement_coffee", fromUserId: ali.id, toUserId: abid.id, groupId: null, amountMinor: 20000, method: "easypaisa", days: 1, note: "Coffee catch-up payment." },
    ];
    for (const payment of payments) {
      await tx.settlement.upsert({ where: { id: payment.id }, update: {}, create: {
        id: payment.id, fromUserId: payment.fromUserId, toUserId: payment.toUserId, groupId: payment.groupId,
        amountMinor: payment.amountMinor, currency: "PKR", method: payment.method, note: payment.note,
        createdByUserId: payment.fromUserId, date: daysAgo(payment.days), createdAt: daysAgo(payment.days),
      } });
      await tx.activity.upsert({ where: { id: `${payment.id}_activity` }, update: {}, create: {
        id: `${payment.id}_activity`, type: "settlement.created", actorId: payment.fromUserId, groupId: payment.groupId,
        metadata: { amountMinor: payment.amountMinor, currency: "PKR", toUserId: payment.toUserId }, createdAt: daysAgo(payment.days),
        recipients: { create: (payment.groupId ? users.map((user) => user.id) : [payment.fromUserId, payment.toUserId]).map((userId) => ({ userId })) },
      } });
    }
    await tx.notification.upsert({ where: { id: "seed_notification_payment" }, update: {}, create: {
      id: "seed_notification_payment", userId: abid.id, type: "settlement.created", title: "Ahmed recorded a payment",
      message: "Ahmed paid you PKR 2,500.00 for Northern escape.", relatedEntityId: "seed_settlement_trip", createdAt: daysAgo(1),
    } });
    await tx.notification.upsert({ where: { id: "seed_notification_expense" }, update: {}, create: {
      id: "seed_notification_expense", userId: abid.id, type: "expense.created", title: "Groceries are sorted",
      message: "Sara added Weekly groceries to Apartment 4B.", relatedEntityId: "seed_expense_groceries", createdAt: daysAgo(2),
    } });
  }, { timeout: 30000 });
  console.log("Sample data ready. Sign in with the development demo credentials documented in README.md.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Sample seed failed.");
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());
