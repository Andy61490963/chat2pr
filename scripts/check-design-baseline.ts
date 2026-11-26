import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { baselinePath, checkBaseline, comparisonBase } from "./design-baseline";
import { entriesAt } from "./design-tokens";

const base = comparisonBase(process.argv[2], process.argv[3]);
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" });
const exists =
  base && git("ls-tree", "--name-only", base, "--", baselinePath).trim();
const previous = exists ? git("show", base + ":" + baselinePath) : null;
checkBaseline(readFileSync(baselinePath, "utf8"), previous, () =>
  base ? entriesAt(base) : [],
);
