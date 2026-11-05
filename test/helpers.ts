/** Test helpers: a D1-compatible database backed by node:sqlite, plus config builders. */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import raw from "../config.json";
import { buildConfig, type Config, type Env, type RawConfig } from "../src/config";
import { Store } from "../src/store";
import { ConsoleNotifier } from "../src/notify";

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Stmt(this.db, this.sql, params); }
  private p() { return this.params.map((v) => (typeof v === "boolean" ? Number(v) : v)) as never[]; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.p()) as T) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.p()) as T[], success: true }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.p());
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database;
}

export const TRAVELERS = {
  RAN: { title: "mr", given_name: "Ran", family_name: "Test", born_on: "1995-01-31", gender: "m",
         email: "ran@example.com", phone_number: "+12065550111" },
  BROCK: { title: "mr", given_name: "Brock", family_name: "Test", born_on: "1995-02-28", gender: "m",
           email: "brock@example.com", phone_number: "+12065550122" },
};

export function testEnv(db = fakeD1()): Env {
  return {
    DB: db,
    CONTACT_RAN_PHONE: "+12065550111",
    CONTACT_BROCK_PHONE: "+12065550122",
    TWILIO_AUTH_TOKEN: "test_auth_token",
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_FROM_NUMBER: "+12065550100",
    PUBLIC_BASE_URL: "https://flights.example.com",
    DUFFEL_ACCESS_TOKEN: "duffel_test_x",
    TRAVELERS_JSON: JSON.stringify(TRAVELERS),
    ADMIN_TOKEN: "admin_secret",
    CONTACT_RAN_EMAIL: "ran@example.com",
    LINK_SECRET: "link_secret",
    RESEND_API_KEY: "re_test",
  };
}

export function makeCfg(overrides: Partial<Config> = {}, env = testEnv()): Config {
  const cfg = buildConfig(env, structuredClone(raw) as RawConfig);
  return Object.assign(cfg, overrides);
}

export function setup(overrides: Partial<Config> = {}) {
  const env = testEnv();
  const cfg = makeCfg(overrides, env);
  return { cfg, store: new Store(env.DB), notifier: new ConsoleNotifier() };
}
