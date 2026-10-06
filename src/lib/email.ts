import "server-only";
import { AppError } from "@/lib/http";

type EmailMessage = { to: string; subject: string; text: string; html?: string };
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return false;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, ...message }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new AppError(502, "The email provider is temporarily unavailable. Please try again later.");
  return true;
}
