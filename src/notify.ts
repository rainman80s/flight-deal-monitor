/**
 * Getting messages to people. Email (via Resend) is the default channel; texts and
 * calls (via Twilio) are optional and off unless alerts.channels lists them.
 */
import { type Config, type Contact, secret } from "./config";
import { TwilioNotifier } from "./twilio";

export interface Email { subject: string; text: string; html: string }

export interface Notifier {
  email(to: string, msg: Email): Promise<void>;
  sms(to: string, body: string): Promise<void>;
  call(to: string, dealCode: string, contact: string): Promise<void>;
}

/** Dry run: records instead of contacting anyone. */
export class ConsoleNotifier implements Notifier {
  sent: { kind: "email" | "sms" | "call"; to: string; body: string; email?: Email }[] = [];
  async email(to: string, msg: Email) {
    this.sent.push({ kind: "email", to, body: msg.text, email: msg });
    console.log(`[DRY RUN] email to ${to}: ${msg.subject}\n${msg.text}`);
  }
  async sms(to: string, body: string) {
    this.sent.push({ kind: "sms", to, body });
    console.log(`[DRY RUN] text to ${to}:\n${body}`);
  }
  async call(to: string, dealCode: string, contact: string) {
    this.sent.push({ kind: "call", to, body: `${dealCode}:${contact}` });
    console.log(`[DRY RUN] would call ${to} (${contact}) about deal ${dealCode}`);
  }
}

/** Resend's send-email API (https://api.resend.com/emails). */
export class ResendEmailer {
  constructor(private apiKey: string, private from: string, private fetcher: typeof fetch = fetch.bind(globalThis)) {}
  async send(to: string, msg: Email) {
    const res = await this.fetcher("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { id?: string };
    console.log(`emailed ${to} (${body.id ?? "?"})`);
  }
}

/** Live mode: email through Resend, texts/calls through Twilio, each only if configured. */
export class LiveNotifier implements Notifier {
  constructor(private emailer?: ResendEmailer, private twilio?: TwilioNotifier) {}
  async email(to: string, msg: Email) {
    if (!this.emailer) throw new Error("email channel not configured (RESEND_API_KEY)");
    await this.emailer.send(to, msg);
  }
  async sms(to: string, body: string) {
    if (!this.twilio) throw new Error("sms channel not configured (Twilio secrets)");
    await this.twilio.sms(to, body);
  }
  async call(to: string, code: string, contact: string) {
    if (!this.twilio) throw new Error("call channel not configured (Twilio secrets)");
    await this.twilio.call(to, code, contact);
  }
}

/** Build a client only if its keys exist, so a missing key breaks sending, not the whole site. */
function optional<T>(make: () => T): T | undefined {
  try { return make(); } catch (e) {
    console.error(`notifier not configured: ${(e as Error).message}`);
    return undefined;
  }
}

export function makeNotifier(cfg: Config): Notifier {
  if (cfg.dryRun) return new ConsoleNotifier();
  const emailer = cfg.channels.includes("email")
    ? optional(() => new ResendEmailer(secret(cfg, "RESEND_API_KEY"), String(cfg.env.EMAIL_FROM ?? cfg.emailFrom)))
    : undefined;
  const twilio = cfg.channels.includes("sms") || cfg.channels.includes("call")
    ? optional(() => new TwilioNotifier(secret(cfg, "TWILIO_ACCOUNT_SID"), secret(cfg, "TWILIO_AUTH_TOKEN"),
        secret(cfg, "TWILIO_FROM_NUMBER"), secret(cfg, "PUBLIC_BASE_URL")))
    : undefined;
  return new LiveNotifier(emailer, twilio);
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain status message (booking results etc.) on every enabled channel the contact has. */
export async function tell(cfg: Config, notifier: Notifier, c: Contact, subject: string, text: string) {
  if (cfg.channels.includes("email") && c.email) {
    const html = `<p style="font-family:sans-serif;font-size:15px">${escHtml(text).replace(/\n/g, "<br>")
      .replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`;
    try { await notifier.email(c.email, { subject, text, html }); } catch (e) { console.error(`email to ${c.name} failed`, e); }
  }
  if (cfg.channels.includes("sms") && c.phone) {
    try { await notifier.sms(c.phone, text); } catch (e) { console.error(`text to ${c.name} failed`, e); }
  }
}
