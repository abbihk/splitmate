import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
export const passwordSchema = z.string().min(10, "Use at least 10 characters.").max(72, "Use at most 72 characters.")
  .regex(/[a-z]/, "Include a lowercase letter.")
  .regex(/[A-Z]/, "Include an uppercase letter.")
  .regex(/[0-9]/, "Include a number.")
  .refine((value) => new TextEncoder().encode(value).length <= 72, "The password must be at most 72 UTF-8 bytes.");
const passwordConfirmation = { password: passwordSchema, confirmPassword: z.string().max(72) };
export const registerSchema = z.object({ name: z.string().trim().min(2, "Enter your full name.").max(80), email: emailSchema, ...passwordConfirmation })
  .refine((data) => data.password === data.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(72), rememberMe: z.boolean().optional().default(false) });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ...passwordConfirmation })
  .refine((data) => data.password === data.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(72), ...passwordConfirmation })
  .refine((data) => data.password === data.confirmPassword, { message: "Passwords do not match.", path: ["confirmPassword"] });

export const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  avatarUrl: z.string().url().max(2048).refine((url) => new URL(url).protocol === "https:", "Use a secure HTTPS image URL.").nullable().optional(),
  defaultCurrency: z.enum(["PKR", "USD", "EUR", "GBP", "AED", "SAR", "INR", "CAD", "AUD"]).optional(),
  timezone: z.string().max(80).refine((zone) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } }, "Choose a valid time zone.").optional(),
  dateFormat: z.enum(["dd MMM yyyy", "dd/MM/yyyy", "MM/dd/yyyy", "yyyy-MM-dd"]).optional(),
  notificationPrefs: z.object({ friendRequests: z.boolean(), groupActivity: z.boolean(), expenses: z.boolean(), payments: z.boolean() }).optional(),
}).strict();

export const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE"), currentPassword: z.string().max(72).optional() });
export const invitationAcceptSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
