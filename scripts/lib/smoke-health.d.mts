type Query = (sql: string, timeout?: number) => string | undefined | Promise<string | undefined>;
type Until = (check: () => Promise<boolean>, seconds: number) => Promise<boolean>;
export function smokeHealth(query: Query, ...options: [] | [readyAt: Date, until: Until]): Promise<string | undefined>;
