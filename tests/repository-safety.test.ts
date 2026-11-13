import { expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { pack } from "tar-stream";
import { gzipSync } from "node:zlib";
import { GitHub } from "../server/github.js";
import { archiveChunks } from "../server/repo-chunks.js";
import { classifyRisk } from "../server/policy.js";

it("GitHub 摘要與封存檔索引都排除憑證、符號連結與自訂敏感路徑", async () => {
  const fakeCredential = "github_pat_" + "x".repeat(82);
  const sources: Record<string, string> = {
    "README.md": "可公開的專案說明",
    "package.json": JSON.stringify({
      name: "範例專案",
      testOnly: fakeCredential,
    }),
    ".codex/auth.json": JSON.stringify({
      tokens: { refresh_token: "fictional-test-token" },
    }),
    "config/deploy.json": "敏感設定",
    "private/docs/project.csproj": "敏感設定",
    "AGENTS.md": JSON.stringify({ client_secret: "fictional-test-value" }),
    "README-link": "可能指向憑證的符號連結",
  };
  const rules = ["config/*.json", "private/**/*.csproj"];
  const requested: string[] = [];
  const api = new Octokit({
    request: {
      fetch: async (url: string) => {
        const pathname = new URL(url).pathname;
        if (pathname.includes("/git/trees/"))
          return Response.json({
            tree: Object.keys(sources).map((path) => ({
              path,
              type: "blob",
              mode: path === "README-link" ? "120000" : "100644",
            })),
            truncated: false,
          });
        const path = pathname.split("/contents/")[1];
        if (!Object.hasOwn(sources, path)) throw Error("無效的測試路徑");
        requested.push(path);
        return Response.json({
          type: "file",
          content: Buffer.from(sources[path]).toString("base64"),
        });
      },
    },
  });
  const github = new GitHub();
  github.client = async () => api;
  github.base = async () => "test-sha";
  github.branches = async () => ({names:["main"],defaultBranch:"main",truncated:false});
  const context = await github.context(
    {
      id: "a",
      repo: "test/repo",
      base_branch: "main",
      sensitive_paths: rules,
    } as Parameters<GitHub["context"]>[0],
    { paths: 100, chars: 16 },
  );
  expect(context.files).toEqual({ "README.md": sources["README.md"] });
  expect(requested.sort()).toEqual(["AGENTS.md", "README.md", "package.json"]);
  expect(context.paths.sort()).toEqual([
    "AGENTS.md",
    "README.md",
    "package.json",
  ]);

  const tar = pack();
  for (const [path, content] of Object.entries(sources)) {
    if (path === "README-link")
      tar.entry({
        name: "root/README-link",
        type: "symlink",
        linkname: ".codex/auth.json",
      });
    else tar.entry({ name: "root/" + path }, content);
  }
  tar.finalize();
  const data: Buffer[] = [];
  for await (const part of tar) if (Buffer.isBuffer(part)) data.push(part);
  const chunks = await archiveChunks(
    new Blob([Uint8Array.from(gzipSync(Buffer.concat(data)))]).stream(),
    rules,
  );
  expect(chunks.map((c) => c.path)).toEqual(["README.md"]);
});

it("派工使用與檔案索引相同的萬用字元規則與既有目錄比對", () => {
  const rules = ["config/*.json", "src/**/auth?.cs", "私有/"];
  for (const path of [
    "Config/production.json",
    "src/Auth7.cs",
    "src/Service/API/Auth2.cs",
    "模組/私有/settings.ts",
    ".codex-service/auth.json",
  ])
    expect(classifyRisk("調整介面", [], [path], rules)).toContain("人工審核");
  expect(
    classifyRisk(
      "調整介面",
      [],
      ["config/公開/顏色.json", "src/cart.ts"],
      rules,
    ),
  ).toBeNull();
});
