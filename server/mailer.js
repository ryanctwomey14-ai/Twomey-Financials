/* ---------------- mail transport ----------------
 *
 * Two ways out, chosen by which credentials are present. Nothing is hardcoded
 * and no credential is ever written here -- they come from the environment, so
 * the secret lives in .env (gitignored) and nowhere else.
 *
 *   Gmail SMTP   GMAIL_USER + GMAIL_APP_PASSWORD
 *   Resend       RESEND_API_KEY + optional DIGEST_FROM
 *
 * Gmail is checked first because it needs no signup: the account already
 * exists, and an app password is issued from it directly.
 */
import nodemailer from "nodemailer";

const env = k => (process.env[k] || "").trim();

export function transportKind() {
  if (env("GMAIL_USER") && env("GMAIL_APP_PASSWORD")) return "gmail";
  if (env("RESEND_API_KEY")) return "resend";
  return null;
}

export function configured() {
  return transportKind() !== null;
}

/* What is missing, phrased as the step that fixes it. */
export function describe() {
  const kind = transportKind();
  if (kind === "gmail") return `Gmail SMTP as ${env("GMAIL_USER")}`;
  if (kind === "resend") return `Resend (${env("DIGEST_FROM") || "onboarding@resend.dev"})`;
  if (env("GMAIL_USER")) return "incomplete: GMAIL_USER is set but GMAIL_APP_PASSWORD is not";
  if (env("GMAIL_APP_PASSWORD")) return "incomplete: GMAIL_APP_PASSWORD is set but GMAIL_USER is not";
  return "not configured";
}

function fromAddress() {
  const kind = transportKind();
  const name = env("DIGEST_FROM_NAME") || "Twomey Wealth Console";
  if (kind === "gmail") return `"${name}" <${env("GMAIL_USER")}>`;
  return env("DIGEST_FROM") || `"${name}" <onboarding@resend.dev>`;
}

/* Gmail's SMTP wants the app password with its spaces stripped. Google shows it
 * as four groups of four, and pasting it as displayed is the common failure. */
const gmailPassword = () => env("GMAIL_APP_PASSWORD").replace(/\s+/g, "");

async function sendViaGmail({ to, subject, html, text }) {
  const tx = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: env("GMAIL_USER"), pass: gmailPassword() }
  });
  const info = await tx.sendMail({ from: fromAddress(), to, subject, html, text });
  return { id: info.messageId, accepted: info.accepted };
}

async function sendViaResend({ to, subject, html, text }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text })
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${body.message || JSON.stringify(body)}`);
  return { id: body.id, accepted: [to] };
}

export async function send({ to, subject, html, text }) {
  const kind = transportKind();
  if (!kind) throw new Error("No mail transport configured. " + describe());
  if (!to) throw new Error("No recipient configured.");
  const out = kind === "gmail" ? await sendViaGmail({ to, subject, html, text })
                               : await sendViaResend({ to, subject, html, text });
  return { ...out, via: kind };
}

/* Prove the credentials before a schedule depends on them. SMTP can say so
 * outright; Resend has no verify endpoint, so presence is all that can be
 * checked without sending something. */
export async function verify() {
  const kind = transportKind();
  if (!kind) return { ok: false, reason: describe() };
  if (kind === "resend") return { ok: true, kind, note: "key present; Resend cannot be checked without sending" };
  try {
    const tx = nodemailer.createTransport({
      host: "smtp.gmail.com", port: 465, secure: true,
      auth: { user: env("GMAIL_USER"), pass: gmailPassword() }
    });
    await tx.verify();
    return { ok: true, kind };
  } catch (e) {
    /* Google's SMTP rejection is opaque. Name the two causes that account for
     * nearly all of them rather than passing the raw text through. */
    const hint = /Username and Password not accepted|BadCredentials/i.test(e.message)
      ? "Gmail rejected the credentials. An app password is required (a normal account password will not work), and the account must have 2-Step Verification switched on."
      : e.message;
    return { ok: false, kind, reason: hint };
  }
}
