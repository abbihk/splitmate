import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loginSchema, passwordSchema, profileSchema, registerSchema, resetPasswordSchema } from "../src/lib/validation";

test("registration normalizes email and requires a matching confirmation", () => {
  const data = { name: "  Amina Khan  ", email: " AMINA@Example.test ", password: "WellChosen123", confirmPassword: "WellChosen123" };
  const parsed = registerSchema.parse(data);
  assert.equal(parsed.name, "Amina Khan");
  assert.equal(parsed.email, "amina@example.test");
  assert.equal(registerSchema.safeParse({ ...data, confirmPassword: "Different123" }).success, false);
});

test("password policy prevents bcrypt byte truncation and weak credentials", () => {
  for (const weak of ["shortA1", "onlylowercase12", "ONLYUPPERCASE12", "NoDigitsPresent"]) assert.equal(passwordSchema.safeParse(weak).success, false);
  assert.equal(passwordSchema.safeParse(`Aa1${"界".repeat(24)}`).success, false, "UTF-8 byte length matters for bcrypt");
  assert.equal(passwordSchema.safeParse(`Aa1${"界".repeat(23)}`).success, true);
});

test("login defaults to a browser session and reset tokens have fixed entropy", () => {
  assert.equal(loginSchema.parse({ email: "person@example.test", password: "ValidPass123" }).rememberMe, false);
  assert.equal(resetPasswordSchema.safeParse({ token: "short", password: "ValidPass123", confirmPassword: "ValidPass123" }).success, false);
  assert.equal(resetPasswordSchema.safeParse({ token: "A".repeat(43), password: "ValidPass123", confirmPassword: "ValidPass123" }).success, true);
});

test("profile rejects unsafe avatar URLs, invalid time zones, and credential edits", () => {
  assert.equal(profileSchema.safeParse({ avatarUrl: "javascript:alert(1)" }).success, false);
  assert.equal(profileSchema.safeParse({ avatarUrl: "http://example.test/avatar.png" }).success, false);
  assert.equal(profileSchema.safeParse({ timezone: "Invalid/Zone" }).success, false);
  assert.equal(profileSchema.safeParse({ passwordHash: "do-not-accept" }).success, false);
  assert.equal(profileSchema.safeParse({ timezone: "Asia/Karachi", defaultCurrency: "PKR", notificationPrefs: { friendRequests: true, groupActivity: false, expenses: true, payments: true } }).success, true);
});
