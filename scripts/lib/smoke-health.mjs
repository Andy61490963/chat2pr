import { readFileSync } from "node:fs";

export function smokeHealth(query) {
  return query(readFileSync(new URL("./smoke-health.sql", import.meta.url), "utf8"));
}
