import { Database } from "./db.js";
import { taipeiDay, AppError } from "./policy.js";
export const prices: Record<
  string,
  { input: number; cached: number; output: number }
> = {
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
};
export class Budget {
  constructor(private db: Database) {}
  async reserve(
    amount: number,
    taskId: string | null = null,
    leaseMinutes: 5 | 35 = taskId ? 35 : 5,
  ) {
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(73461)");
      const { value: s } = (
        await c.query("SELECT value FROM settings WHERE id=1")
      ).rows[0];
      if (s.paused) throw new AppError(409, "系統已暫停派工");
      const day = taipeiDay();
      const { total } = (
        await c.query(
          "SELECT (SELECT COALESCE(sum(cost),0) FROM usage WHERE (created_at AT TIME ZONE 'Asia/Taipei')::date=$1::date)+(SELECT COALESCE(sum(GREATEST(amount-spent,0)),0) FROM reservations WHERE NOT released) AS total",
          [day],
        )
      ).rows[0];
      if (Number(total) + amount > Number(s.daily_budget))
        throw new AppError(429, "今日預估額度不足，工作已保留");
      return (
        await c.query(
          "INSERT INTO reservations(task_id,day,amount,expires_at) VALUES($1,$2,$3,now()+make_interval(mins=>$4)) RETURNING id",
          [taskId, day, amount, leaseMinutes],
        )
      ).rows[0].id as string;
    });
  }
  async resize(id: string, amount: number) {
    await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(73461)");
      const { value: s } = (
        await c.query("SELECT value FROM settings WHERE id=1")
      ).rows[0];
      const r = (
        await c.query(
          "SELECT * FROM reservations WHERE id=$1 AND NOT released AND expires_at>now() FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!r || s.paused) throw new AppError(409, "預留額度已失效或系統暫停");
      const { total } = (
        await c.query(
          "SELECT (SELECT COALESCE(sum(cost),0) FROM usage WHERE (created_at AT TIME ZONE 'Asia/Taipei')::date=$1::date)+(SELECT COALESCE(sum(GREATEST(amount-spent,0)),0) FROM reservations WHERE NOT released AND id<>$2) AS total",
          [taipeiDay(), id],
        )
      ).rows[0];
      if (!Number.isFinite(amount) || amount > Number(s.task_budget))
        throw new AppError(422, "此批輸入超過單次預估上限，請拆分需求");
      if (Number(total) + amount - Number(r.spent) > Number(s.daily_budget))
        throw new AppError(429, "今日預估額度不足以處理此批輸入");
      await c.query(
        "UPDATE reservations SET amount=GREATEST($2,spent),expires_at=now()+interval '5 minutes' WHERE id=$1",
        [id, amount],
      );
    });
  }
  async recoverExpired(id?: string) {
    await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(73461)");
      const rows = (
        await c.query(
          "SELECT * FROM reservations WHERE NOT released AND (expires_at<now() OR id=$1) FOR UPDATE",
          [id ?? null],
        )
      ).rows;
      for (const r of rows) {
        const unknown = Math.max(0, Number(r.amount) - Number(r.spent));
        await c.query(
          "INSERT INTO usage(reservation_id,model,input_tokens,cached_tokens,output_tokens,cost) VALUES($1,'中斷後保守估算',0,0,0,$2)",
          [r.id, unknown],
        );
        await c.query(
          "UPDATE reservations SET released=true,spent=GREATEST(spent,amount) WHERE id=$1",
          [r.id],
        );
      }
    });
  }
  async charge(
    id: string,
    model: string,
    input: number,
    cached: number,
    output: number,
  ) {
    const p = prices[model];
    if (!p) throw new AppError(400, "模型尚未設定費率");
    // 長上下文以較高費率估算；所有帳務門檻皆屬預估。
    const multiplier = model === "gpt-6.1-sol" && input > 272000 ? 2 : 1;
    const cost =
      (((input - cached) * p.input + cached * p.cached + output * p.output) *
        multiplier) /
      1e6;
    await this.db.transaction(async (c) => {
      await c.query("UPDATE reservations SET spent=spent+$2 WHERE id=$1", [
        id,
        cost,
      ]);
      await c.query(
        "INSERT INTO usage(reservation_id,model,input_tokens,cached_tokens,output_tokens,cost) VALUES($1,$2,$3,$4,$5,$6)",
        [id, model, input, cached, output, cost],
      );
    });
    return cost;
  }
  async allowed(id: string) {
    const r = await this.db.one<{
      amount: string;
      spent: string;
      released: boolean;
      day: string;
      expires_at: Date;
    }>("SELECT * FROM reservations WHERE id=$1", [id]);
    if (
      !r ||
      r.released ||
      new Date(r.expires_at).getTime() <= Date.now() ||
      Number(r.spent) >= Number(r.amount)
    )
      throw new AppError(429, "本次任務預估額度已用完");
    const s = await this.db.settings();
    if (s.paused) throw new AppError(409, "系統已暫停");
    const spent = await this.db.one<{ total: number }>(
      "SELECT COALESCE(sum(cost),0)::float AS total FROM usage WHERE (created_at AT TIME ZONE 'Asia/Taipei')::date=$1::date",
      [taipeiDay()],
    );
    if (spent.total >= Number(s.daily_budget))
      throw new AppError(429, "今日預估額度已用完");
  }
  async release(id: string) {
    await this.db.query("UPDATE reservations SET released=true WHERE id=$1", [
      id,
    ]);
  }
  async summary() {
    return this.db.one(
      "SELECT $1::text AS day,(SELECT COALESCE(sum(cost),0)::float FROM usage WHERE (created_at AT TIME ZONE 'Asia/Taipei')::date=$1::date) AS spent,(SELECT COALESCE(sum(GREATEST(amount-spent,0)),0)::float FROM reservations WHERE NOT released) AS reserved",
      [taipeiDay()],
    );
  }
}
