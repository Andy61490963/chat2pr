import { collectCandidate } from "./trusted-changes.mjs";

process.stdout.write(JSON.stringify(await collectCandidate()));
