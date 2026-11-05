/** Twilio over plain fetch: send texts, place calls, build TwiML, verify webhook signatures. */


/** Texts and calls (optional channel; alerts default to email). */
export class TwilioNotifier {
  private base: string;
  constructor(private sid: string, private token: string, private from: string, publicBaseUrl: string,
              private fetcher: typeof fetch = fetch) {
    this.base = publicBaseUrl.replace(/\/$/, "");
  }

  private async post(resource: string, form: Record<string, string>) {
    const res = await this.fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${this.sid}/${resource}.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa(`${this.sid}:${this.token}`),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form),
      });
    if (!res.ok) throw new Error(`Twilio ${resource} failed: ${res.status} ${await res.text()}`);
    return res.json() as Promise<{ sid: string }>;
  }

  async sms(to: string, body: string) {
    const r = await this.post("Messages", { To: to, From: this.from, Body: body });
    console.log(`texted ${to} (${r.sid})`);
  }

  async call(to: string, dealCode: string, contact: string) {
    const r = await this.post("Calls", {
      To: to, From: this.from, Method: "POST", Timeout: "30",
      Url: `${this.base}/voice/deal/${dealCode}?who=${encodeURIComponent(contact)}`,
    });
    console.log(`calling ${to} about ${dealCode} (${r.sid})`);
  }
}

// ---------------- TwiML ----------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const VOICE = "Polly.Joanna";
export const say = (text: string) => `<Say voice="${VOICE}">${esc(text)}</Say>`;
export const pause = (s = 1) => `<Pause length="${s}"/>`;
export const gather = (action: string, inner: string, timeout = 8) =>
  `<Gather numDigits="1" action="${esc(action)}" method="POST" timeout="${timeout}">${inner}</Gather>`;
export const redirect = (url: string) => `<Redirect method="POST">${esc(url)}</Redirect>`;
export const message = (text: string) => `<Message>${esc(text)}</Message>`;
export const twiml = (inner = "") =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });

// ---------------- signatures ----------------

/**
 * Twilio's X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value) of POST params)).
 */
export async function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function validTwilioRequest(authToken: string, url: string, params: Record<string, string>,
                                         signature: string): Promise<boolean> {
  if (!signature) return false;
  const expected = await twilioSignature(authToken, url, params);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
