import { randomBytes, createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { AppError } from "@/lib/http";
import { parseMoney, safeMinorNumber, splitExpense } from "@/lib/money";
import { calculateBalances } from "@/lib/balances";
import type { ExpenseInput, GroupInput, SettlementInput } from "@/lib/domain-validation";

export const publicUserSelect = { id: true, name: true, email: true, avatarUrl: true, defaultCurrency: true } satisfies Prisma.UserSelect;
const expenseInclude = {
  group: { select: { id: true, name: true, archived: true } },
  createdBy: { select: publicUserSelect }, paidBy: { select: publicUserSelect },
  payers: { include: { user: { select: publicUserSelect } } },
  participants: { include: { user: { select: publicUserSelect } } },
} satisfies Prisma.ExpenseInclude;
const groupInclude = { members: { include: { user: { select: publicUserSelect } }, orderBy: { joinedAt: "asc" as const } }, createdBy: { select: publicUserSelect }, _count: { select: { expenses: true } } } satisfies Prisma.GroupInclude;
const settlementInclude = { fromUser: { select: publicUserSelect }, toUser: { select: publicUserSelect }, createdBy: { select: publicUserSelect }, group: { select: { id: true, name: true } } } satisfies Prisma.SettlementInclude;
type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>;
type SettlementRow = Prisma.SettlementGetPayload<{ include: typeof settlementInclude }>;
type Tx = Prisma.TransactionClient;
type PublicUser = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

export function decimalMoney(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Amounts must be safe integer minor units.");
  const sign = minor < 0 ? "-" : "";
  const value = BigInt(minor < 0 ? -minor : minor);
  return `${sign}${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}
function addAmount(first: number, second: number) { return safeMinorNumber(BigInt(first) + BigInt(second)); }
function calendarDate(value: string) { return new Date(`${value.slice(0, 10)}T00:00:00.000Z`); }
function safeMoney(value: string, positive = true): number {
  try {
    const amount = parseMoney(value);
    if (positive && amount <= 0) throw new Error("Amount must be greater than zero.");
    return amount;
  } catch (error) { throw new AppError(400, error instanceof Error ? error.message : "Invalid amount."); }
}
export function serializeExpense(expense: ExpenseRow) {
  return { ...expense, amount: decimalMoney(expense.amountMinor),
    payers: expense.payers.map((payer) => ({ ...payer, amount: decimalMoney(payer.amountMinor) })),
    participants: expense.participants.map((participant) => ({ ...participant, amountOwed: decimalMoney(participant.amountOwedMinor), value: expense.splitType === "percentage" ? decimalMoney(participant.percentage ?? 0) : expense.splitType === "shares" ? String(participant.shares ?? 0) : decimalMoney(participant.amountOwedMinor) })),
  };
}
function serializeSettlement(settlement: SettlementRow) {
  return { ...settlement, amount: decimalMoney(settlement.amountMinor), settlementDate: settlement.date, paymentMethod: settlement.method };
}
export function expenseScope(userId: string): Prisma.ExpenseWhereInput {
  return { OR: [
    { groupId: null, OR: [{ createdByUserId: userId }, { payers: { some: { userId } } }, { participants: { some: { userId } } }] },
    { group: { members: { some: { userId } } } },
  ] };
}
function settlementScope(userId: string): Prisma.SettlementWhereInput {
  return { OR: [{ groupId: null, OR: [{ fromUserId: userId }, { toUserId: userId }] }, { group: { members: { some: { userId } } } }] };
}
function pairKey(first: string, second: string) { return [first, second].sort().join(":"); }
async function serializable<T>(userId: string, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        if (!await tx.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } })) throw new AppError(401, "This account is no longer available.");
        return operation(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
    }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
        if (attempt < 2) continue;
        throw new AppError(409, "Another change was made at the same time. Please retry.");
      }
      throw error;
    }
  }
  throw new AppError(409, "Please retry your change.");
}
async function membership(tx: Tx, userId: string, groupId: string, admin = false, active = false) {
  const member = await tx.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } }, include: { group: true } });
  if (!member) throw new AppError(404, "Group not found.");
  if (admin && !["owner", "admin"].includes(member.role)) throw new AppError(403, "Only group owners and admins can do that.");
  if (active && member.group.archived) throw new AppError(409, "This group is archived. Restore it before making changes.");
  return member;
}
async function requireFriends(tx: Tx, userId: string, ids: string[]) {
  const uniqueIds = [...new Set(ids)].filter((id) => id !== userId);
  if (!uniqueIds.length) return;
  const relationships = await tx.friendship.findMany({ where: { status: "accepted", pairKey: { in: uniqueIds.map((id) => pairKey(userId, id)) } } });
  if (relationships.length !== uniqueIds.length) throw new AppError(400, "All participants must be accepted friends.");
  const users = await tx.user.count({ where: { id: { in: uniqueIds }, deletedAt: null } });
  if (users !== uniqueIds.length) throw new AppError(400, "One of these accounts is unavailable.");
}
type Event = { actorId: string; type: string; recipients: string[]; title: string; message: string; preference: "friendRequests" | "groupActivity" | "expenses" | "payments"; groupId?: string | null; expenseId?: string | null; entityId?: string; metadata?: Prisma.InputJsonValue };
async function event(tx: Tx, input: Event) {
  const ids = [...new Set([input.actorId, ...input.recipients])];
  await tx.activity.create({ data: { actorId: input.actorId, type: input.type, groupId: input.groupId, expenseId: input.expenseId, metadata: input.metadata ?? { message: input.message }, recipients: { create: ids.map((userId) => ({ userId })) } } });
  const users = await tx.user.findMany({ where: { id: { in: ids.filter((id) => id !== input.actorId) }, deletedAt: null }, select: { id: true, notificationPrefs: true } });
  const notifications = users.filter((user) => {
    const prefs = user.notificationPrefs;
    return !(prefs && typeof prefs === "object" && !Array.isArray(prefs) && prefs[input.preference] === false);
  }).map((user) => ({ userId: user.id, type: input.type, title: input.title, message: input.message, relatedEntityId: input.entityId }));
  if (notifications.length) await tx.notification.createMany({ data: notifications });
}
async function groupMemberIds(tx: Tx, groupId: string) {
  return (await tx.groupMember.findMany({ where: { groupId }, select: { userId: true } })).map((member) => member.userId);
}

export async function listUsers(userId: string, q: string) {
  const query = q.trim().slice(0, 100);
  if (query.length < 2) return [];
  return db.user.findMany({ where: { deletedAt: null, id: { not: userId }, OR: [{ name: { contains: query, mode: "insensitive" } }, { email: { contains: query, mode: "insensitive" } }] }, select: publicUserSelect, take: 20, orderBy: { name: "asc" } });
}
export async function listFriends(userId: string) {
  const relationships = await db.friendship.findMany({ where: { OR: [{ requesterId: userId }, { receiverId: userId }], status: { in: ["accepted", "pending"] } }, include: { requester: { select: publicUserSelect }, receiver: { select: publicUserSelect } }, orderBy: { updatedAt: "desc" } });
  return relationships.map((relationship) => ({ ...relationship, user: relationship.requesterId === userId ? relationship.receiver : relationship.requester, direction: relationship.requesterId === userId ? "outgoing" : "incoming" }));
}
export async function requestFriend(userId: string, input: { receiverId?: string; email?: string }) {
  return serializable(userId, async (tx) => {
    const receiver = await tx.user.findFirst({ where: { deletedAt: null, ...(input.receiverId ? { id: input.receiverId } : { email: input.email!.trim().toLowerCase() }) }, select: publicUserSelect });
    if (!receiver) throw new AppError(404, "No registered account found. Send an email invitation instead.");
    if (receiver.id === userId) throw new AppError(400, "You cannot send yourself a friend request.");
    const existing = await tx.friendship.findUnique({ where: { pairKey: pairKey(userId, receiver.id) } });
    if (existing?.status === "accepted") throw new AppError(409, "You are already friends.");
    if (existing?.status === "pending") throw new AppError(409, existing.requesterId === userId ? "Your request is already pending." : "This person has already sent you a request. Accept it from your friends page.");
    if (existing?.status === "blocked") throw new AppError(403, "This request cannot be sent.");
    const request = existing ? await tx.friendship.update({ where: { id: existing.id }, data: { requesterId: userId, receiverId: receiver.id, status: "pending" } }) : await tx.friendship.create({ data: { requesterId: userId, receiverId: receiver.id, pairKey: pairKey(userId, receiver.id) } });
    await event(tx, { actorId: userId, type: "friend_request", recipients: [receiver.id], title: "New friend request", message: "You received a friend request.", preference: "friendRequests", entityId: request.id, metadata: { message: "Sent a friend request", friendId: receiver.id, friendName: receiver.name } });
    return { ...request, user: receiver };
  });
}
export async function respondFriend(userId: string, id: string, accept: boolean) {
  return serializable(userId, async (tx) => {
    const relationship = await tx.friendship.findFirst({ where: { id, receiverId: userId, status: "pending" } });
    if (!relationship) throw new AppError(404, "Pending request not found.");
    const result = await tx.friendship.update({ where: { id }, data: { status: accept ? "accepted" : "declined" }, include: { requester: { select: publicUserSelect }, receiver: { select: publicUserSelect } } });
    await event(tx, { actorId: userId, type: accept ? "friend_accepted" : "friend_declined", recipients: [relationship.requesterId], title: accept ? "Friend request accepted" : "Friend request declined", message: accept ? "Your friend request was accepted." : "Your friend request was declined.", preference: "friendRequests", entityId: id });
    return result;
  });
}
export async function removeFriend(userId: string, id: string) {
  return serializable(userId, async (tx) => {
    const relationship = await tx.friendship.findFirst({ where: { OR: [{ id }, { requesterId: userId, receiverId: id }, { requesterId: id, receiverId: userId }], AND: [{ OR: [{ requesterId: userId }, { receiverId: userId }] }] } });
    if (!relationship) throw new AppError(404, "Friendship not found.");
    const otherId = relationship.requesterId === userId ? relationship.receiverId : relationship.requesterId;
    if (relationship.status === "accepted") {
      const [expenses, settlements] = await Promise.all([
        tx.expense.findMany({ where: { groupId: null, AND: [expenseScope(userId), expenseScope(otherId)] }, include: { payers: true, participants: true } }),
        tx.settlement.findMany({ where: { groupId: null, OR: [{ fromUserId: userId, toUserId: otherId }, { fromUserId: otherId, toUserId: userId }] } }),
      ]);
      if (calculateBalances(expenses, settlements).some((row) => row.debts.some((debt) => ((debt.fromUserId === userId && debt.toUserId === otherId) || (debt.fromUserId === otherId && debt.toUserId === userId)) && debt.amountMinor > 0))) throw new AppError(409, "Settle your personal balance before removing this friend.");
    }
    await tx.friendship.delete({ where: { id: relationship.id } });
    await event(tx, { actorId: userId, type: "friend_removed", recipients: [otherId], title: "Friend removed", message: "A friendship was removed.", preference: "friendRequests", entityId: otherId });
    return { success: true };
  });
}

export async function listGroups(userId: string, includeArchived = false) {
  return db.group.findMany({ where: { members: { some: { userId } }, ...(includeArchived ? {} : { archived: false }) }, include: groupInclude, orderBy: { updatedAt: "desc" } });
}
export async function createGroup(userId: string, input: GroupInput) {
  return serializable(userId, async (tx) => {
    const memberIds = [...new Set([userId, ...input.memberIds])];
    await requireFriends(tx, userId, memberIds);
    const { memberIds: _memberIds, ...fields } = input;
    const group = await tx.group.create({ data: { ...fields, createdById: userId, members: { create: memberIds.map((memberId) => ({ userId: memberId, role: memberId === userId ? "owner" : "member" })) } }, include: groupInclude });
    await event(tx, { actorId: userId, type: "group_created", groupId: group.id, recipients: memberIds, preference: "groupActivity", title: "Added to a group", message: `You were added to ${group.name}.`, entityId: group.id, metadata: { message: `Created ${group.name}`, groupName: group.name } });
    return group;
  });
}
export async function getGroup(userId: string, id: string) {
  const group = await db.group.findFirst({ where: { id, members: { some: { userId } } }, include: groupInclude });
  if (!group) throw new AppError(404, "Group not found.");
  const [expenses, settlements] = await Promise.all([
    db.expense.findMany({ where: { groupId: id }, include: expenseInclude, orderBy: [{ expenseDate: "desc" }, { id: "desc" }], take: 25 }),
    db.settlement.findMany({ where: { groupId: id }, include: settlementInclude, orderBy: { date: "desc" }, take: 25 }),
  ]);
  return { ...group, expenses: expenses.map(serializeExpense), settlements: settlements.map(serializeSettlement), balances: await groupBalances(userId, id) };
}
export async function updateGroup(userId: string, id: string, input: Prisma.GroupUpdateInput) {
  return serializable(userId, async (tx) => {
    await membership(tx, userId, id, true);
    const group = await tx.group.update({ where: { id }, data: input, include: groupInclude });
    await event(tx, { actorId: userId, type: input.archived === true ? "group_archived" : "group_updated", groupId: id, recipients: group.members.map((member) => member.userId), preference: "groupActivity", title: "Group updated", message: `${group.name} was updated.`, entityId: id, metadata: { message: `Updated ${group.name}`, groupName: group.name } });
    return group;
  });
}
export async function addGroupMember(userId: string, id: string, memberId: string) {
  return serializable(userId, async (tx) => {
    const actor = await membership(tx, userId, id, true, true);
    await requireFriends(tx, userId, [memberId]);
    if (await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: memberId } } })) throw new AppError(409, "This person is already a member.");
    const member = await tx.groupMember.create({ data: { groupId: id, userId: memberId }, include: { user: { select: publicUserSelect } } });
    await event(tx, { actorId: userId, type: "member_added", groupId: id, recipients: await groupMemberIds(tx, id), preference: "groupActivity", title: "Group member added", message: `${member.user.name} was added to ${actor.group.name}.`, entityId: id, metadata: { message: `Added ${member.user.name} to ${actor.group.name}`, memberId, groupName: actor.group.name } });
    return member;
  });
}
export async function changeMemberRole(userId: string, id: string, memberId: string, role: string) {
  return serializable(userId, async (tx) => {
    const actor = await membership(tx, userId, id, true, true);
    if (actor.role !== "owner") throw new AppError(403, "Only the group owner can change roles.");
    const member = await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: memberId } } });
    if (!member) throw new AppError(404, "Member not found.");
    if (member.role === "owner") throw new AppError(400, "The owner role cannot be changed.");
    const updated = await tx.groupMember.update({ where: { id: member.id }, data: { role }, include: { user: { select: publicUserSelect } } });
    await event(tx, { actorId: userId, type: "member_role_updated", groupId: id, recipients: await groupMemberIds(tx, id), preference: "groupActivity", title: "Group role changed", message: `${updated.user.name} is now a ${role} in ${actor.group.name}.`, entityId: id });
    return updated;
  });
}
export async function removeGroupMember(userId: string, id: string, memberId: string) {
  return serializable(userId, async (tx) => {
    const actor = await membership(tx, userId, id, memberId !== userId, true);
    const member = await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: memberId } }, include: { user: { select: publicUserSelect } } });
    if (!member) throw new AppError(404, "Member not found.");
    if (member.role === "owner") throw new AppError(400, "The group owner cannot be removed.");
    if (actor.role === "admin" && member.role === "admin" && memberId !== userId) throw new AppError(403, "Only the owner can remove another admin.");
    const [expenses, settlements] = await Promise.all([tx.expense.findMany({ where: { groupId: id }, include: { payers: true, participants: true } }), tx.settlement.findMany({ where: { groupId: id } })]);
    if (calculateBalances(expenses, settlements).some((currency) => currency.balances.some((balance) => balance.userId === memberId && balance.amountMinor !== 0))) throw new AppError(409, "This member must settle every currency balance before leaving the group.");
    const recipients = await groupMemberIds(tx, id);
    await tx.groupMember.delete({ where: { id: member.id } });
    await event(tx, { actorId: userId, type: "member_removed", groupId: id, recipients, preference: "groupActivity", title: "Group member removed", message: `${member.user.name} left ${actor.group.name}.`, entityId: id, metadata: { message: `${member.user.name} left ${actor.group.name}`, memberId, groupName: actor.group.name } });
    return { success: true };
  });
}

export function pagination(url: URL) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}
export async function listExpenses(userId: string, url: URL) {
  const { page, pageSize, skip } = pagination(url);
  const params = url.searchParams;
  const filters: Prisma.ExpenseWhereInput[] = [expenseScope(userId)];
  const q = params.get("q")?.trim().slice(0, 100);
  if (q) filters.push({ OR: [{ title: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }] });
  if (params.get("groupId")) filters.push({ groupId: params.get("groupId") === "personal" ? null : params.get("groupId") });
  if (params.get("friendId")) filters.push({ OR: [{ payers: { some: { userId: params.get("friendId")! } } }, { participants: { some: { userId: params.get("friendId")! } } }] });
  for (const field of ["category", "currency", "createdByUserId"] as const) if (params.get(field)) filters.push({ [field]: params.get(field) });
  const payerId = params.get("paidBy") || params.get("paidByUserId");
  if (payerId) filters.push({ payers: { some: { userId: payerId } } });
  for (const [query, bound] of [["from", "gte"], ["to", "lte"]] as const) {
    const value = params.get(query);
    if (value) {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) throw new AppError(400, "Invalid date filter.");
      if (query === "to" && /^\d{4}-\d{2}-\d{2}$/.test(value)) parsed.setUTCHours(23, 59, 59, 999);
      filters.push({ expenseDate: { [bound]: parsed } });
    }
  }
  for (const [query, bound] of [["minAmount", "gte"], ["maxAmount", "lte"]] as const) if (params.get(query)) filters.push({ amountMinor: { [bound]: safeMoney(params.get(query)!, false) } });
  const where = { AND: filters };
  const [expenses, total] = await Promise.all([db.expense.findMany({ where, include: expenseInclude, orderBy: [{ expenseDate: "desc" }, { id: "desc" }], skip, take: pageSize }), db.expense.count({ where })]);
  return { data: expenses.map(serializeExpense), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}
export async function getExpense(userId: string, id: string) {
  const expense = await db.expense.findFirst({ where: { id, AND: [expenseScope(userId)] }, include: expenseInclude });
  if (!expense) throw new AppError(404, "Expense not found.");
  return serializeExpense(expense);
}
async function authorizeExpenseEdit(tx: Tx, userId: string, expense: ExpenseRow) {
  if (expense.groupId) {
    const member = await membership(tx, userId, expense.groupId, false, true);
    if (expense.createdByUserId !== userId && !["owner", "admin"].includes(member.role)) throw new AppError(403, "Only the creator or a group admin can edit this expense.");
  } else if (expense.createdByUserId !== userId) throw new AppError(403, "Only the creator can edit this expense.");
}
async function expenseData(tx: Tx, userId: string, input: ExpenseInput) {
  const allIds = [...new Set([...input.participants.map((participant) => participant.userId), ...input.payers.map((payer) => payer.userId)])];
  if (await tx.user.count({ where: { id: { in: allIds }, deletedAt: null } }) !== allIds.length) throw new AppError(400, "Every payer and participant must have an active account.");
  let recipients: string[];
  if (input.groupId) {
    await membership(tx, userId, input.groupId, false, true);
    recipients = await groupMemberIds(tx, input.groupId);
    if (allIds.some((id) => !recipients.includes(id))) throw new AppError(400, "Every payer and participant must belong to this group.");
  } else {
    if (!allIds.includes(userId)) throw new AppError(400, "You must pay or participate in a personal expense.");
    await requireFriends(tx, userId, allIds);
    recipients = allIds;
  }
  const amountMinor = safeMoney(input.amount);
  const payers = input.payers.map((payer) => ({ userId: payer.userId, amountMinor: safeMoney(payer.amount) }));
  if (payers.reduce((total, payer) => total + payer.amountMinor, 0) !== amountMinor) throw new AppError(400, "Payer contributions must equal the expense total.");
  let participants: ReturnType<typeof splitExpense>;
  try {
    participants = splitExpense(amountMinor, input.splitType, input.participants.map((participant) => {
      const raw = participant.value;
      if (input.splitType === "shares" && (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 1000000)) throw new Error("Shares must be positive whole numbers, up to 1,000,000.");
      return { userId: participant.userId, value: input.splitType === "equal" ? undefined : input.splitType === "shares" ? Number(raw) : safeMoney(raw!, false) };
    }));
  } catch (error) { throw new AppError(400, error instanceof Error ? error.message : "Invalid split."); }
  return { recipients, payers, participants, fields: { title: input.title, description: input.description, amountMinor, currency: input.currency, groupId: input.groupId || null, paidByUserId: payers.length === 1 ? payers[0].userId : null, expenseDate: calendarDate(input.expenseDate), category: input.category, receiptUrl: input.receiptUrl, splitType: input.splitType } };
}
export async function createExpense(userId: string, input: ExpenseInput) {
  return serializable(userId, async (tx) => {
    const data = await expenseData(tx, userId, input);
    const expense = await tx.expense.create({ data: { ...data.fields, createdByUserId: userId, payers: { create: data.payers }, participants: { create: data.participants } }, include: expenseInclude });
    await event(tx, { actorId: userId, type: "expense_created", groupId: expense.groupId, expenseId: expense.id, recipients: data.recipients, preference: "expenses", title: "New shared expense", message: `${expense.title}: ${expense.currency} ${decimalMoney(expense.amountMinor)} was added.`, entityId: expense.id, metadata: { message: `Added ${expense.title}`, title: expense.title, amountMinor: expense.amountMinor, currency: expense.currency } });
    return serializeExpense(expense);
  });
}
export async function updateExpense(userId: string, id: string, input: ExpenseInput) {
  return serializable(userId, async (tx) => {
    const existing = await tx.expense.findFirst({ where: { id, AND: [expenseScope(userId)] }, include: expenseInclude });
    if (!existing) throw new AppError(404, "Expense not found.");
    await authorizeExpenseEdit(tx, userId, existing);
    if ((input.groupId || null) !== existing.groupId) throw new AppError(400, "An expense cannot be moved between accounting groups. Create a new expense instead.");
    const data = await expenseData(tx, userId, input);
    // Keep both old and new participants informed when correcting the ledger.
    const recipients = [...data.recipients, ...existing.payers.map((payer) => payer.userId), ...existing.participants.map((participant) => participant.userId)];
    await tx.expensePayer.deleteMany({ where: { expenseId: id } });
    await tx.expenseParticipant.deleteMany({ where: { expenseId: id } });
    const expense = await tx.expense.update({ where: { id }, data: { ...data.fields, payers: { create: data.payers }, participants: { create: data.participants } }, include: expenseInclude });
    await event(tx, { actorId: userId, type: "expense_updated", groupId: expense.groupId, expenseId: id, recipients, preference: "expenses", title: "Expense updated", message: `${expense.title} was updated.`, entityId: id, metadata: { message: `Updated ${expense.title}`, title: expense.title, previousAmountMinor: existing.amountMinor, amountMinor: expense.amountMinor, currency: expense.currency } });
    return serializeExpense(expense);
  });
}
export async function deleteExpense(userId: string, id: string) {
  return serializable(userId, async (tx) => {
    const expense = await tx.expense.findFirst({ where: { id, AND: [expenseScope(userId)] }, include: expenseInclude });
    if (!expense) throw new AppError(404, "Expense not found.");
    await authorizeExpenseEdit(tx, userId, expense);
    const recipients = expense.groupId ? await groupMemberIds(tx, expense.groupId) : [...expense.payers.map((payer) => payer.userId), ...expense.participants.map((participant) => participant.userId)];
    await event(tx, { actorId: userId, type: "expense_deleted", groupId: expense.groupId, recipients, preference: "expenses", title: "Expense deleted", message: `${expense.title} was deleted.`, metadata: { message: `Deleted ${expense.title}`, title: expense.title, amountMinor: expense.amountMinor, currency: expense.currency, deletedExpenseId: id } });
    await tx.expense.delete({ where: { id } });
    return { success: true };
  });
}

export async function listSettlements(userId: string, url: URL) {
  const { page, pageSize, skip } = pagination(url);
  const filters: Prisma.SettlementWhereInput[] = [settlementScope(userId)];
  const groupId = url.searchParams.get("groupId");
  if (groupId) filters.push({ groupId: groupId === "personal" ? null : groupId });
  const friendId = url.searchParams.get("friendId");
  if (friendId) filters.push({ OR: [{ fromUserId: friendId }, { toUserId: friendId }] });
  const currency = url.searchParams.get("currency");
  if (currency) filters.push({ currency });
  const where = { AND: filters };
  const [settlements, total] = await Promise.all([db.settlement.findMany({ where, include: settlementInclude, orderBy: [{ date: "desc" }, { id: "desc" }], take: pageSize, skip }), db.settlement.count({ where })]);
  return { data: settlements.map(serializeSettlement), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}
export async function createSettlement(userId: string, input: SettlementInput) {
  return serializable(userId, async (tx) => {
    if (![input.fromUserId, input.toUserId].includes(userId)) throw new AppError(403, "Only the sender or recipient can record this payment.");
    const groupId = input.groupId || null;
    let recipients: string[];
    if (groupId) {
      await membership(tx, userId, groupId);
      recipients = await groupMemberIds(tx, groupId);
      if (![input.fromUserId, input.toUserId].every((id) => recipients.includes(id))) throw new AppError(400, "Both people must belong to the group.");
    } else {
      recipients = [input.fromUserId, input.toUserId];
    }
    if (await tx.user.count({ where: { id: { in: [input.fromUserId, input.toUserId] }, deletedAt: null } }) !== 2) throw new AppError(400, "Both people must have active accounts.");
    const amountMinor = safeMoney(input.amount);
    // Serializable reads prevent two concurrent repayments from over-settling a debt.
    const [expenses, settlements] = await Promise.all([
      tx.expense.findMany({ where: { groupId, currency: input.currency, ...(groupId ? {} : expenseScope(userId)) }, include: { payers: true, participants: true } }),
      tx.settlement.findMany({ where: { groupId, currency: input.currency, ...(groupId ? {} : { OR: [{ fromUserId: userId }, { toUserId: userId }] }) } }),
    ]);
    const ledger = calculateBalances(expenses, settlements).find((row) => row.currency === input.currency);
    let outstanding = 0;
    if (groupId && ledger) {
      const sender = ledger.balances.find((balance) => balance.userId === input.fromUserId)?.amountMinor ?? 0;
      const receiver = ledger.balances.find((balance) => balance.userId === input.toUserId)?.amountMinor ?? 0;
      outstanding = Math.min(Math.max(-sender, 0), Math.max(receiver, 0));
    } else if (ledger) outstanding = ledger.debts.find((debt) => debt.fromUserId === input.fromUserId && debt.toUserId === input.toUserId)?.amountMinor ?? 0;
    if (amountMinor > outstanding) throw new AppError(400, outstanding ? `The payment exceeds the outstanding ${input.currency} ${decimalMoney(outstanding)} balance.` : "There is no outstanding balance in this direction and accounting scope.");
    const settlement = await tx.settlement.create({ data: { fromUserId: input.fromUserId, toUserId: input.toUserId, groupId, amountMinor, currency: input.currency, date: calendarDate(input.settlementDate), method: input.paymentMethod, note: input.note, createdByUserId: userId }, include: settlementInclude });
    await event(tx, { actorId: userId, type: "payment_recorded", groupId, recipients, preference: "payments", title: "Payment recorded", message: `${settlement.fromUser.name} paid ${settlement.toUser.name} ${input.currency} ${decimalMoney(amountMinor)}.`, entityId: settlement.id, metadata: { message: `${settlement.fromUser.name} paid ${settlement.toUser.name}`, amountMinor, currency: input.currency, fromUserId: input.fromUserId, toUserId: input.toUserId, settlementId: settlement.id } });
    return serializeSettlement(settlement);
  });
}

async function financialRecords(userId: string) {
  return Promise.all([db.expense.findMany({ where: expenseScope(userId), include: expenseInclude }), db.settlement.findMany({ where: settlementScope(userId), include: settlementInclude })]);
}
function scopeLedgers(expenses: ExpenseRow[], settlements: SettlementRow[]) {
  const ids = new Set<string | null>([...expenses.map((expense) => expense.groupId), ...settlements.map((settlement) => settlement.groupId)]);
  return [...ids].flatMap((groupId) => calculateBalances(expenses.filter((expense) => expense.groupId === groupId), settlements.filter((settlement) => settlement.groupId === groupId)).map((ledger) => ({ groupId, ...ledger })));
}
function userDirectory(expenses: ExpenseRow[], settlements: SettlementRow[]) {
  const users = new Map<string, PublicUser>();
  for (const expense of expenses) for (const person of [...expense.payers, ...expense.participants]) users.set(person.userId, person.user);
  for (const payment of settlements) { users.set(payment.fromUserId, payment.fromUser); users.set(payment.toUserId, payment.toUser); }
  return users;
}
function buildBalances(userId: string, expenses: ExpenseRow[], settlements: SettlementRow[]) {
  const directory = userDirectory(expenses, settlements);
  const ledgers = scopeLedgers(expenses, settlements);
  const totals = new Map<string, { currency: string; netMinor: number; oweMinor: number; owedMinor: number }>();
  const peers: { userId: string; user: PublicUser | undefined; currency: string; amountMinor: number; amount: string; groupId: string | null }[] = [];
  const recommendations = ledgers.flatMap((ledger) => {
    const entries = ledger.groupId ? ledger.recommendations : ledger.debts;
    const relevant = entries.filter((entry) => entry.fromUserId === userId || entry.toUserId === userId);
    const total = totals.get(ledger.currency) ?? { currency: ledger.currency, netMinor: 0, oweMinor: 0, owedMinor: 0 };
    for (const entry of relevant) {
      const owed = entry.toUserId === userId;
      const otherId = owed ? entry.fromUserId : entry.toUserId;
      if (owed) total.owedMinor = addAmount(total.owedMinor, entry.amountMinor); else total.oweMinor = addAmount(total.oweMinor, entry.amountMinor);
      peers.push({ userId: otherId, user: directory.get(otherId), currency: ledger.currency, amountMinor: owed ? entry.amountMinor : -entry.amountMinor, amount: decimalMoney(owed ? entry.amountMinor : -entry.amountMinor), groupId: ledger.groupId });
    }
    total.netMinor = addAmount(total.owedMinor, -total.oweMinor);
    totals.set(ledger.currency, total);
    return relevant.map((entry) => ({ ...entry, amount: decimalMoney(entry.amountMinor), currency: ledger.currency, groupId: ledger.groupId, fromUser: directory.get(entry.fromUserId), toUser: directory.get(entry.toUserId) }));
  });
  return { currencies: [...totals.values()].map((total) => ({ ...total, net: decimalMoney(total.netMinor), owe: decimalMoney(total.oweMinor), owed: decimalMoney(total.owedMinor) })), peers, recommendations, groups: ledgers.filter((ledger) => ledger.groupId).map((ledger) => ({ ...ledger, balances: ledger.balances.map((balance) => ({ ...balance, user: directory.get(balance.userId), amount: decimalMoney(balance.amountMinor) })) })) };
}
export async function allBalances(userId: string) {
  const [expenses, settlements] = await financialRecords(userId);
  return buildBalances(userId, expenses, settlements);
}
export async function groupBalances(userId: string, groupId: string) {
  await membership(db, userId, groupId);
  const [expenses, settlements] = await Promise.all([db.expense.findMany({ where: { groupId }, include: expenseInclude }), db.settlement.findMany({ where: { groupId }, include: settlementInclude })]);
  const directory = userDirectory(expenses, settlements);
  return calculateBalances(expenses, settlements).map((ledger) => ({ ...ledger, balances: ledger.balances.map((balance) => ({ ...balance, user: directory.get(balance.userId), amount: decimalMoney(balance.amountMinor) })), recommendations: ledger.recommendations.map((entry) => ({ ...entry, amount: decimalMoney(entry.amountMinor), fromUser: directory.get(entry.fromUserId), toUser: directory.get(entry.toUserId), currency: ledger.currency, groupId })) }));
}
export async function friendDetails(userId: string, id: string) {
  if (userId === id) throw new AppError(404, "Friend not found.");
  const friendship = await db.friendship.findFirst({ where: { status: "accepted", AND: [{ OR: [{ id }, { requesterId: id }, { receiverId: id }] }, { OR: [{ requesterId: userId }, { receiverId: userId }] }] }, include: { requester: { select: publicUserSelect }, receiver: { select: publicUserSelect } } });
  if (!friendship) throw new AppError(404, "Friend not found.");
  const friend = friendship.requesterId === userId ? friendship.receiver : friendship.requester;
  const balances = await allBalances(userId);
  const [expenses, settlements] = await Promise.all([
    db.expense.findMany({ where: { AND: [expenseScope(userId), { OR: [{ payers: { some: { userId: friend.id } } }, { participants: { some: { userId: friend.id } } }] }] }, include: expenseInclude, orderBy: { expenseDate: "desc" }, take: 25 }),
    db.settlement.findMany({ where: { AND: [settlementScope(userId), { OR: [{ fromUserId: userId, toUserId: friend.id }, { fromUserId: friend.id, toUserId: userId }] }] }, include: settlementInclude, orderBy: { date: "desc" }, take: 25 }),
  ]);
  return { friendship, user: friend, balances: balances.peers.filter((peer) => peer.userId === friend.id), recommendations: balances.recommendations.filter((entry) => entry.fromUserId === friend.id || entry.toUserId === friend.id), expenses: expenses.map(serializeExpense), settlements: settlements.map(serializeSettlement) };
}

export async function listActivity(userId: string, url: URL) {
  const { page, pageSize, skip } = pagination(url);
  const filters: Prisma.ActivityWhereInput[] = [{ recipients: { some: { userId } } }];
  const type = url.searchParams.get("type");
  const prefix = ({ expenses: "expense_", payments: "payment_", groups: "group_", friends: "friend_" } as Record<string, string>)[type || ""];
  if (prefix) filters.push(type === "groups" ? { OR: [{ type: { startsWith: "group_" } }, { type: { startsWith: "member_" } }] } : { type: { startsWith: prefix } });
  if (url.searchParams.get("groupId")) filters.push({ groupId: url.searchParams.get("groupId") });
  const where = { AND: filters };
  const [data, total] = await Promise.all([db.activity.findMany({ where, include: { actor: { select: publicUserSelect }, group: { select: { id: true, name: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: pageSize }), db.activity.count({ where })]);
  return { data, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}
export async function listNotifications(userId: string, url: URL) {
  const { page, pageSize, skip } = pagination(url);
  const where = { userId, ...(url.searchParams.get("unread") === "true" ? { isRead: false } : {}) };
  const [data, total, unreadCount] = await Promise.all([db.notification.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip, take: pageSize }), db.notification.count({ where }), db.notification.count({ where: { userId, isRead: false } })]);
  return { data, unreadCount, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}
export async function readNotification(userId: string, id?: string) {
  const result = await db.notification.updateMany({ where: { userId, ...(id ? { id } : {}), isRead: false }, data: { isRead: true } });
  if (id && !result.count && !await db.notification.findFirst({ where: { id, userId }, select: { id: true } })) throw new AppError(404, "Notification not found.");
  return { success: true, updated: result.count };
}
export async function search(userId: string, q: string) {
  const query = q.trim().slice(0, 100);
  if (query.length < 2) return { friends: [], groups: [], expenses: [] };
  const [friends, groups, expenses] = await Promise.all([
    db.friendship.findMany({ where: { status: "accepted", OR: [{ requesterId: userId, receiver: { OR: [{ name: { contains: query, mode: "insensitive" } }, { email: { contains: query, mode: "insensitive" } }] } }, { receiverId: userId, requester: { OR: [{ name: { contains: query, mode: "insensitive" } }, { email: { contains: query, mode: "insensitive" } }] } }] }, include: { requester: { select: publicUserSelect }, receiver: { select: publicUserSelect } }, take: 10 }),
    db.group.findMany({ where: { members: { some: { userId } }, name: { contains: query, mode: "insensitive" } }, include: groupInclude, take: 10 }),
    db.expense.findMany({ where: { AND: [expenseScope(userId), { title: { contains: query, mode: "insensitive" } }] }, include: expenseInclude, take: 10, orderBy: { expenseDate: "desc" } }),
  ]);
  return { friends: friends.map((relationship) => ({ id: relationship.id, user: relationship.requesterId === userId ? relationship.receiver : relationship.requester })), groups, expenses: expenses.map(serializeExpense) };
}
export async function listInvitations(userId: string) {
  return db.invitation.findMany({ where: { invitedById: userId }, select: { id: true, email: true, groupId: true, expiresAt: true, acceptedAt: true, createdAt: true, group: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
}
export async function createInvitation(userId: string, input: { email: string; groupId?: string }) {
  return serializable(userId, async (tx) => {
    const email = input.email.trim().toLowerCase();
    const inviter = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect });
    if (email === inviter.email) throw new AppError(400, "You cannot invite yourself.");
    if (input.groupId) await membership(tx, userId, input.groupId, true, true);
    const existing = await tx.invitation.findFirst({ where: { invitedById: userId, email, groupId: input.groupId || null, acceptedAt: null, expiresAt: { gt: new Date() } } });
    if (existing) throw new AppError(409, "An invitation is already pending for this email.");
    const token = randomBytes(32).toString("base64url");
    const invitation = await tx.invitation.create({ data: { email, invitedById: userId, groupId: input.groupId || null, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 7 * 86400000) }, select: { id: true, email: true, groupId: true, expiresAt: true } });
    const target = await tx.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    await event(tx, { actorId: userId, type: "friend_invited", groupId: input.groupId, recipients: target ? [target.id] : [], preference: "friendRequests", title: "Invitation received", message: `${inviter.name} invited you to SplitMate.`, entityId: invitation.id, metadata: { message: "Sent an invitation", invitationId: invitation.id } });
    return { invitation, token, inviter };
  });
}

export async function dashboard(user: { id: string; name: string; email: string; defaultCurrency: string; timezone?: string; avatarUrl?: string | null }) {
  const [records, groups, friends, activity, notifications] = await Promise.all([financialRecords(user.id), listGroups(user.id), listFriends(user.id), listActivity(user.id, new URL("http://local/api/activity?pageSize=8")), listNotifications(user.id, new URL("http://local/api/notifications?pageSize=10"))]);
  const [expenses, settlements] = records;
  // Calendar months follow the user's timezone, while values always remain integer minor units.
  const zone = user.timezone || "Asia/Karachi";
  const monthFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit" });
  const monthKey = (date: Date) => {
    const parts = monthFormatter.formatToParts(date);
    return `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
  };
  const currentMonth = monthKey(new Date());
  const spending = new Map<string, { month: string; currency: string; amountMinor: number }>();
  const categories = new Map<string, { category: string; currency: string; amountMinor: number }>();
  const thisMonth = new Map<string, number>();
  for (const expense of expenses) {
    const share = expense.participants.find((participant) => participant.userId === user.id)?.amountOwedMinor ?? 0;
    if (!share) continue;
    const month = expense.expenseDate.toISOString().slice(0, 7);
    const key = `${month}:${expense.currency}`;
    const entry = spending.get(key) ?? { month, currency: expense.currency, amountMinor: 0 };
    entry.amountMinor = addAmount(entry.amountMinor, share); spending.set(key, entry);
    if (month === currentMonth) {
      thisMonth.set(expense.currency, addAmount(thisMonth.get(expense.currency) ?? 0, share));
      const categoryKey = `${expense.category}:${expense.currency}`;
      const category = categories.get(categoryKey) ?? { category: expense.category, currency: expense.currency, amountMinor: 0 };
      category.amountMinor = addAmount(category.amountMinor, share); categories.set(categoryKey, category);
    }
  }
  return { user, expenses: expenses.sort((a, b) => b.expenseDate.getTime() - a.expenseDate.getTime()).slice(0, 8).map(serializeExpense), settlements: settlements.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 5).map(serializeSettlement), groups, friends, balances: buildBalances(user.id, expenses, settlements), activity: activity.data, notifications: notifications.data, unreadCount: notifications.unreadCount, monthlySpending: [...spending.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-72).map((value) => ({ ...value, amount: decimalMoney(value.amountMinor) })), categorySpending: [...categories.values()].map((value) => ({ ...value, amount: decimalMoney(value.amountMinor) })), thisMonthSpending: [...thisMonth.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor, amount: decimalMoney(amountMinor) })), currentMonth };
}
