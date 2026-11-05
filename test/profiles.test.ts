/** Account page: traveler profiles are validated, encrypted at rest, and used for booking. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { sessionCookie } from "../src/auth";
import { contactByName } from "../src/config";
import { loadAllTravelers, ProfileStore, validateProfile } from "../src/profiles";
import { setup, TRAVELERS } from "./helpers";

const BASE = "https://flights.example.com";
const TODAY = "2026-11-05";
const good = {
  title: "mr", given_name: "Ran", family_name: "Enbothel", born_on: "1995-01-31", gender: "m",
  email: "Ran@Example.com", phone_number: "+1 (206) 555-0111",
};

describe("validateProfile", () => {
  it("normalizes good input", () => {
    const v = validateProfile(good, null, TODAY);
    expect(v).toMatchObject({ ok: true, profile: { email: "ran@example.com", phone_number: "+12065550111" } });
  });

  it("flags each bad field", () => {
    const v = validateProfile({ ...good, title: "sir", given_name: "R4n", born_on: "2030-01-01", gender: "x",
      email: "nope", phone_number: "2065550111" }, null, TODAY);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(Object.keys(v.errors).sort()).toEqual(["born_on", "gender", "given_name", "phone_number", "title"]
      .concat("email").sort());
  });

  it("passport is all-or-nothing, and a blank number keeps the saved one", () => {
    const partial = validateProfile({ ...good, passport_country: "US" }, null, TODAY);
    expect(partial.ok).toBe(false);
    const full = validateProfile({ ...good, passport_number: "x1234567", passport_expires_on: "2031-01-01",
      passport_country: "us" }, null, TODAY);
    expect(full).toMatchObject({ ok: true, profile: { passport_number: "X1234567", passport_country: "US" } });
    const kept = validateProfile({ ...good, passport_number: "", passport_expires_on: "2032-01-01", passport_country: "US" },
      full.ok ? full.profile : null, TODAY);
    expect(kept).toMatchObject({ ok: true, profile: { passport_number: "X1234567", passport_expires_on: "2032-01-01" } });
    const expired = validateProfile({ ...good, passport_number: "X1234567", passport_expires_on: "2020-01-01",
      passport_country: "US" }, null, TODAY);
    expect(expired.ok).toBe(false);
  });
});

describe("ProfileStore", () => {
  it("stores encrypted and reads back", async () => {
    const { cfg } = setup();
    const store = new ProfileStore(cfg);
    const v = validateProfile({ ...good, passport_number: "X1234567", passport_expires_on: "2031-01-01",
      passport_country: "US" }, null, TODAY);
    if (!v.ok) throw new Error("invalid");
    await store.save("RAN", v.profile, "RAN");
    const raw = await cfg.env.DB.prepare("SELECT data FROM traveler_profiles WHERE contact='RAN'").first<{ data: string }>();
    expect(raw!.data).toMatch(/^v1\./);
    expect(raw!.data).not.toContain("Enbothel");
    expect(raw!.data).not.toContain("X1234567");
    expect(await store.get("RAN")).toMatchObject({ family_name: "Enbothel", passport_number: "X1234567" });
  });

  it("a row copied to another traveler can't be decrypted", async () => {
    const { cfg } = setup();
    const store = new ProfileStore(cfg);
    const v = validateProfile(good, null, TODAY);
    if (!v.ok) throw new Error("invalid");
    await store.save("RAN", v.profile, "RAN");
    await cfg.env.DB.prepare(
      "INSERT INTO traveler_profiles(contact,data,updated_at,updated_by) SELECT 'BROCK', data, updated_at, updated_by FROM traveler_profiles WHERE contact='RAN'",
    ).run();
    expect(await store.get("BROCK")).toBeNull();
  });

  it("booking prefers saved profiles over the TRAVELERS_JSON secret", async () => {
    const { cfg } = setup();
    const v = validateProfile(good, null, TODAY);
    if (!v.ok) throw new Error("invalid");
    await new ProfileStore(cfg).save("RAN", v.profile, "RAN");
    const all = await loadAllTravelers(cfg);
    expect(all.RAN.family_name).toBe("Enbothel");
    expect(all.BROCK.family_name).toBe(TRAVELERS.BROCK.family_name); // still from the secret
  });
});

describe("profile endpoints", () => {
  function site() {
    const ctx = setup({ dryRun: false, bookingEnabled: true });
    const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
    const call = async (method: string, path: string, b?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(BASE + path, { method, body: b === undefined ? undefined : JSON.stringify(b),
        headers: { "Content-Type": "application/json", Origin: BASE, ...headers } }), deps);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    return { ...ctx, call };
  }

  it("need sign-in and same origin", async () => {
    const s = site();
    expect((await s.call("GET", "/api/profiles")).status).toBe(401);
    expect((await s.call("PUT", "/api/profiles/RAN", good)).status).toBe(401);
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    expect((await s.call("PUT", "/api/profiles/RAN", good, { Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403);
  });

  it("save, list (passport masked), field errors, unknown traveler", async () => {
    const s = site();
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    const h = { Cookie: cookie };
    const bad = await s.call("PUT", "/api/profiles/RAN", { ...good, born_on: "" }, h);
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toHaveProperty("born_on");
    const ok = await s.call("PUT", "/api/profiles/BROCK", { ...good, given_name: "Brock", passport_number: "Z9876543",
      passport_expires_on: "2031-01-01", passport_country: "US" }, h);
    expect(ok.status).toBe(200);
    const list = await s.call("GET", "/api/profiles", undefined, h);
    const brock = (list.body.travelers as Record<string, unknown>[]).find((t) => t.name === "BROCK")!;
    expect(brock).toMatchObject({ source: "account", updated_by: "RAN", is_you: false });
    expect(JSON.stringify(list.body)).not.toContain("Z9876543");
    expect((brock.profile as Record<string, unknown>).passport_number_hint).toBe("•••• 543");
    expect((await s.call("PUT", "/api/profiles/MALLORY", good, h)).status).toBe(404);
  });
});
