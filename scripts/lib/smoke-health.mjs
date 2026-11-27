import { readFileSync } from "node:fs";

export async function smokeHealth(query, readyAt, until) {
  const sql = readFileSync(new URL("./smoke-health.sql", import.meta.url), "utf8")
    .replaceAll(":ready_at", readyAt ? `'${readyAt.toISOString()}'` : "NULL");
  if (!readyAt) return query(sql);
  let failures;
  await until(async () => {
    failures = await query(sql, 10000);
    return failures === undefined || !failures.split(/\r?\n/).includes("codex_subscription_gate");
  }, 120);
  return failures;
}
