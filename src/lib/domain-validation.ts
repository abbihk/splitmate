import { z } from "zod";

export const currencySchema = z.enum(["PKR", "USD", "EUR", "GBP", "AED", "SAR", "INR", "CAD", "AUD"]);
const id = z.string().min(1).max(100);
const money = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/, "Enter a positive amount with up to two decimal places.");
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();
const date = z.string().max(40).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || Number.isNaN(Date.parse(value))) return false;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}, "Enter a valid calendar date.");

export const friendRequestSchema = z.object({ receiverId: id.optional(), email: z.string().trim().email().max(254).optional() }).refine((value) => Boolean(value.receiverId || value.email), "Choose a user or email address.");
export const invitationSchema = z.object({ email: z.string().trim().email().max(254), groupId: id.optional() });
export const groupSchema = z.object({
  name: z.string().trim().min(1).max(100), description: optionalText(2000),
  groupType: z.enum(["trip", "home", "couple", "office", "dinner", "event", "general"]).default("general"),
  defaultCurrency: currencySchema.default("PKR"), memberIds: z.array(id).max(100).default([]),
  icon: z.string().max(40).default("users"), imageUrl: z.string().url().max(2048).optional().nullable(),
});
// Update fields deliberately have no creation defaults: a name change must not reset currency or type.
export const groupUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(), description: optionalText(2000),
  groupType: z.enum(["trip", "home", "couple", "office", "dinner", "event", "general"]).optional(),
  defaultCurrency: currencySchema.optional(), icon: z.string().max(40).optional(),
  imageUrl: z.string().url().max(2048).optional().nullable(), archived: z.boolean().optional(),
}).refine((input) => Object.keys(input).length > 0, "Choose a field to update.");
export const addMemberSchema = z.object({ userId: id });
export const memberRoleSchema = z.object({ role: z.enum(["admin", "member"]) });
export const expenseSchema = z.object({
  title: z.string().trim().min(1).max(160), description: optionalText(4000), amount: money,
  currency: currencySchema, expenseDate: date,
  category: z.enum(["food", "transport", "shopping", "rent", "utilities", "entertainment", "travel", "hotel", "fuel", "medical", "groceries", "education", "other"]),
  groupId: id.optional().nullable(), receiptUrl: z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Receipt links must use HTTPS.").optional().nullable(),
  splitType: z.enum(["equal", "exact", "percentage", "shares"]),
  participants: z.array(z.object({ userId: id, value: z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/).optional() })).min(1).max(100),
  payers: z.array(z.object({ userId: id, amount: money })).min(1).max(100),
}).superRefine((value, context) => {
  for (const key of ["participants", "payers"] as const) {
    if (new Set(value[key].map((entry) => entry.userId)).size !== value[key].length) context.addIssue({ code: "custom", path: [key], message: "Each person must appear only once." });
  }
  if (value.splitType !== "equal" && value.participants.some((entry) => entry.value === undefined)) context.addIssue({ code: "custom", path: ["participants"], message: "Provide a value for each participant." });
});
export const settlementSchema = z.object({
  fromUserId: id, toUserId: id, amount: money, currency: currencySchema, groupId: id.optional().nullable(),
  paymentMethod: z.enum(["cash", "bank_transfer", "jazzcash", "easypaisa", "card", "other"]).default("cash"),
  note: optionalText(2000), settlementDate: date,
}).refine((value) => value.fromUserId !== value.toUserId, "A payment needs two different people.");

export type ExpenseInput = z.infer<typeof expenseSchema>;
export type GroupInput = z.infer<typeof groupSchema>;
export type SettlementInput = z.infer<typeof settlementSchema>;
