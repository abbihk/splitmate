import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

const integrationUrl = process.env.INTEGRATION_URL;

test("authentication protects cookies, origins, sessions, recovery, and account settings", { skip: !integrationUrl, timeout: 90000 }, async (t) => {
  const origin = new URL(integrationUrl!).origin;
  const email = `auth-${randomUUID()}@example.test`;
  let password = "AuthTestPass123!";
  let cookie = "";
  let registered = false;
  const call = async (path: string, method = "GET", body?: unknown, options: { cookie?: string; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    const activeCookie = options.cookie === undefined ? cookie : options.cookie;
    if (activeCookie) headers.Cookie = activeCookie;
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      if (options.origin !== null) headers.Origin = options.origin || origin;
    }
    const response = await fetch(`${origin}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json() as Record<string, any>;
    return { response, data };
  };
  const setCookie = (response: Response) => {
    const header = response.headers.get("set-cookie") || "";
    assert.ok(header.includes("HttpOnly"), "The session cookie must be HTTP-only");
    assert.ok(/SameSite=Lax/i.test(header), "The session cookie must limit cross-site access");
    assert.ok(/Path=\//i.test(header), "The session must be scoped to this application");
    cookie = header.split(";")[0];
    return header;
  };
  try {
    assert.equal((await call("/api/auth/me", "GET", undefined, { cookie: "" })).response.status, 401);
    const rejectedGoogle = await fetch(`${origin}/api/auth/google/callback?state=invalid&code=invalid`, { redirect: "manual" });
    assert.equal(rejectedGoogle.status, 307);
    assert.ok(new URL(rejectedGoogle.headers.get("location")!).searchParams.has("error"), "A forged OAuth callback must return a safe error");
    assert.ok(!(rejectedGoogle.headers.get("set-cookie") || "").includes("splitmate_session="), "A forged callback must never create a session");
    assert.equal((await call("/api/auth/register", "POST", {}, { origin: null })).response.status, 403);
    assert.equal((await call("/api/auth/register", "POST", {}, { origin: "https://attacker.example" })).response.status, 403);
    const registration = { name: "Auth Integration", email, password, confirmPassword: password };
    const invalid = await call("/api/auth/register", "POST", { ...registration, confirmPassword: "Mismatch123" });
    assert.equal(invalid.response.status, 400);
    const created = await call("/api/auth/register", "POST", registration);
    assert.equal(created.response.status, 201, created.data.error);
    registered = true;
    const browserCookie = setCookie(created.response);
    assert.ok(!browserCookie.toLowerCase().includes("max-age="), "Remember me off should use a browser-session cookie");
    assert.equal(created.data.user.email, email);
    assert.equal(created.data.user.hasPassword, true);
    assert.equal("passwordHash" in created.data.user, false);
    assert.equal("googleId" in created.data.user, false);
    assert.equal((await call("/api/auth/register", "POST", registration)).response.status, 409);
    assert.equal((await call("/api/auth/me")).response.status, 200);
    const firstCookie = cookie;

    assert.equal((await call("/api/profile", "PATCH", { name: "Bad origin" }, { origin: "https://attacker.example" })).response.status, 403);
    assert.equal((await call("/api/auth/logout", "POST", {}, { origin: null })).response.status, 403);
    assert.equal((await call("/api/profile", "PATCH", { passwordHash: "tamper" })).response.status, 400);
    const profile = await call("/api/profile", "PATCH", { name: "Updated Name", defaultCurrency: "USD", timezone: "Asia/Karachi" });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.data.user.name, "Updated Name");

    const remembered = await call("/api/auth/login", "POST", { email, password, rememberMe: true });
    assert.equal(remembered.response.status, 200);
    const rememberCookie = setCookie(remembered.response);
    assert.ok(/Max-Age=2592000/i.test(rememberCookie), "Remember me should last 30 days");
    const sessions = await call("/api/sessions");
    assert.equal(sessions.response.status, 200);
    assert.ok(sessions.data.sessions.length >= 2);
    assert.equal(sessions.data.sessions.filter((session: { current: boolean }) => session.current).length, 1);
    assert.equal("tokenHash" in sessions.data.sessions[0], false);
    assert.equal((await call("/api/sessions", "DELETE")).response.status, 200);
    assert.equal((await call("/api/auth/me", "GET", undefined, { cookie: firstCookie })).response.status, 401);
    assert.equal((await call("/api/auth/me")).response.status, 200);
    assert.equal((await call("/api/auth/reset-password", "POST", { token: "A".repeat(43), password, confirmPassword: password })).response.status, 400);

    const recovery = await call("/api/auth/forgot-password", "POST", { email });
    assert.equal(recovery.response.status, 200, recovery.data.error);
    const resetUrl = recovery.data.developmentResetUrl as string | undefined;
    await t.test("one-use recovery token revokes every session", { skip: !resetUrl }, async () => {
      const token = new URL(resetUrl!).searchParams.get("token");
      const nextPassword = "RecoveredPass456!";
      const reset = await call("/api/auth/reset-password", "POST", { token, password: nextPassword, confirmPassword: nextPassword });
      assert.equal(reset.response.status, 200);
      password = nextPassword;
      assert.equal((await call("/api/auth/me")).response.status, 401);
      assert.equal((await call("/api/auth/reset-password", "POST", { token, password, confirmPassword: password })).response.status, 400);
      assert.equal((await call("/api/auth/login", "POST", { email, password: "AuthTestPass123!" })).response.status, 401);
    });

    const signedIn = await call("/api/auth/login", "POST", { email, password });
    assert.equal(signedIn.response.status, 200);
    setCookie(signedIn.response);
    assert.equal((await call("/api/profile/password", "PATCH", { currentPassword: "Incorrect123", password: "ChangedPass789!", confirmPassword: "ChangedPass789!" })).response.status, 400);
    const changed = await call("/api/profile/password", "PATCH", { currentPassword: password, password: "ChangedPass789!", confirmPassword: "ChangedPass789!" });
    assert.equal(changed.response.status, 200);
    password = "ChangedPass789!";
    assert.equal((await call("/api/auth/me")).response.status, 401);
    const afterChange = await call("/api/auth/login", "POST", { email, password });
    assert.equal(afterChange.response.status, 200);
    setCookie(afterChange.response);
    const deleted = await call("/api/profile", "DELETE", { confirmation: "DELETE", currentPassword: password });
    assert.equal(deleted.response.status, 200, deleted.data.error);
    registered = false;
    assert.equal((await call("/api/auth/me")).response.status, 401);
  } finally {
    if (registered) {
      const signedIn = await call("/api/auth/login", "POST", { email, password });
      if (signedIn.response.ok) {
        setCookie(signedIn.response);
        await call("/api/profile", "DELETE", { confirmation: "DELETE", currentPassword: password });
      }
    }
  }
});
