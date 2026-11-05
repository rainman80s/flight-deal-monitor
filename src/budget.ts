/**
 * Hard limit on paid API requests (Ignav), kept in D1 so every run and every
 * Worker instance shares one count. take() reserves a request before it is made
 * and throws BudgetExceeded once today's or the all-time limit is reached.
 */
import { utcDate } from "./dates";

export class BudgetExceeded extends Error {}

export interface BudgetUsage { today: number; total: number; dailyLimit: number; totalLimit: number }

export class Budget {
  constructor(private db: D1Database, private name: string, private dailyLimit: number,
              private totalLimit: number, private now: () => Date = () => new Date()) {}

  private keys() {
    return { total: `${this.name}_total`, day: `${this.name}_day_${utcDate(this.now())}` };
  }

  private async bump(key: string, limit: number): Promise<boolean> {
    await this.db.prepare("INSERT INTO state(key,value) VALUES(?, '0') ON CONFLICT(key) DO NOTHING").bind(key).run();
    // Increment only while under the limit; atomic in a single statement.
    const r = await this.db.prepare(
      "UPDATE state SET value = CAST(value AS INTEGER) + 1 WHERE key=? AND CAST(value AS INTEGER) < ? RETURNING value",
    ).bind(key, limit).first<{ value: number }>();
    return r !== null;
  }

  private async unbump(key: string) {
    await this.db.prepare("UPDATE state SET value = MAX(CAST(value AS INTEGER) - 1, 0) WHERE key=?").bind(key).run();
  }

  /** Reserve one request, or throw BudgetExceeded. */
  async take(): Promise<void> {
    const k = this.keys();
    if (!(await this.bump(k.total, this.totalLimit))) {
      throw new BudgetExceeded(`${this.name}: all-time limit of ${this.totalLimit} requests reached`);
    }
    if (!(await this.bump(k.day, this.dailyLimit))) {
      await this.unbump(k.total);
      throw new BudgetExceeded(`${this.name}: today's limit of ${this.dailyLimit} requests reached`);
    }
  }

  async usage(): Promise<BudgetUsage> {
    const k = this.keys();
    const get = async (key: string) => Number((await this.db.prepare("SELECT value FROM state WHERE key=?")
      .bind(key).first<{ value: string }>())?.value ?? 0);
    return { today: await get(k.day), total: await get(k.total), dailyLimit: this.dailyLimit, totalLimit: this.totalLimit };
  }
}
