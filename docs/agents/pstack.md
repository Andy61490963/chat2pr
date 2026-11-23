# 用 pstack 的方式開發

本專案的 AI 開發（Claude Code 與 Codex）以 pstack 為基準。pstack 是 Lauren Tan（poteto）整理的一組 Agent skill，原作在 [cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack)；我們用的是 Claude Code／Codex 移植版 [michael-denyer/pstack-claude](https://github.com/michael-denyer/pstack-claude)（MIT）。

核心想法：寫更少但品質更高的程式；先查清楚再動手；每一步都要拿得出證據；同一個錯第二次出現，就改結構把它擋住。

## 優先順序

**本儲存庫的 `AGENTS.md` 與 `docs/conventions.md` 優先於 pstack。** pstack 的開工提示也寫明使用者與專案指示優先。兩者衝突時照本專案規則做，並在下面「本專案的例外」補上一條。

## 安裝與版本

| 位置                | 設定                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 專案                | `.claude/settings.json` 宣告 marketplace `pstack-claude` 並啟用 `pstack@pstack-claude`。開啟專案時 Claude Code 會詢問是否信任並安裝。 |
| Claude Code（個人） | `~/.claude/settings.json` 同樣的兩個欄位。                                                                                            |
| Codex               | `codex plugin marketplace add michael-denyer/pstack-claude --ref <commit>`，再 `codex plugin add pstack@pstack-claude`。              |

- 版本一律鎖在**審閱過的 commit**（`ref`），並關閉自動更新。第三方套件更新前先讀過差異，特別是 `plugins/pstack/hooks/` 與各 skill 的 `scripts/`，確認沒有新的連網、寫設定或刪檔動作，再改 `ref`。
- 目前鎖定：`6b63a37001b9c5bee58197fce569aefbecb3763f`（pstack 0.9.150）。
- 部分 poteto-mode 工具腳本需要 [bun](https://bun.sh)；沒有 bun 時 skill 本身仍可用，只是那些腳本不能跑。

## 什麼時候用

- 動到兩個以上檔案、改到別處會呼叫的函式簽名、需要設計取捨、原因不明的 bug 或效能問題：從 `/pstack:poteto-mode`（Codex 用 `$pstack:poteto-mode`）開始，它會挑劇本並列待辦。
- 單一檔案的小改動、問答、一行修正：直接做，在真實介面上驗證。
- 意圖已經很明確時直接用對應 skill，見下表。

## 本專案流程對應的 skill

| 步驟     | 本專案做法                                                 | pstack skill                                                                                 |
| -------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 接需求   | 先開 Issue 寫規格（`docs/agents/issue-tracker.md`）        | `poteto-mode` 挑劇本；需求模糊時 `in-your-own-words`                                         |
| 理解現況 | 讀 `CONTEXT.md`、`docs/conventions.md` 與相關程式          | `how`（怎麼運作）、`why`（從 commit 與 PR 查為何這樣寫）、`blast-radius`（小改動會波及哪裡） |
| 設計     | 跨函式邊界、新的 API 欄位                                  | `architect`：先定呼叫方式、型別與模組形狀                                                    |
| 修 bug   | 先重現                                                     | `tdd`：先寫會失敗的測試，再修                                                                |
| 平行處理 | 多張 Issue 分給 Codex，各自一個 worktree                   | `swarm`（不同切片）、`arena`（同一題多版取最好）                                             |
| 驗證     | typecheck、相關測試、e2e、375px、axe、截圖                 | 原則 `prove-it-works`；專案驗證 skill 用 `create-verification-skill` 建立                    |
| 審查     | 審查者跑測試、看畫面；退件原因清單                         | `interrogate`：讓不同模型試著弄壞 diff，只留跑得出來的問題                                   |
| 收斂教訓 | 新的潛規則寫進 `docs/conventions.md`、退件原因寫進派工說明 | `correct`（從歷史找重複的錯並從根本修）、`reflect`（把長任務的做法存成 skill）               |
| 開 PR    | 繁體中文、Conventional Commits、`Closes #N`、Squash        | 劇本「opening a pr」；格式照本專案                                                           |

## 本專案的例外

| pstack 的做法                          | 本專案                                                                                              | 原因                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 預設英文                               | 文件、介面、Issue、PR、commit、程式註解一律繁體中文                                                 | 使用者與維護者都以繁體中文溝通。                               |
| 「不卡在人身上」：能做就做，不可逆才問 | 部署只在部署目錄用 `npm run deploy`；正式資料庫寫入、機密、刪除資料、權限與產品範圍的決定一律先問人 | 這些動作影響正式環境或屬於使用者的決定，見 `AGENTS.md`。       |
| `no-comments`：審查前移除註解          | 只能在審查時暫時隱藏註解來看程式本身；不可刪除既有說明「為什麼」的註解                              | 本專案的註解記錄決策原因與踩過的坑，刪掉就失去脈絡。           |
| `arena`／`swarm` 平行執行              | 可以平行寫程式，但 `npx vitest run` 一次只跑一個分支                                                | 測試共用同一個資料庫，同時跑會互相干擾而假失敗。               |
| `worktree cleanup` 劇本                | 只清開發目錄的 `.claude/worktrees/`；先 `cmd /c rmdir` 拆掉 `node_modules` 連結再移除 worktree      | 部署目錄不能切分支或改檔；直接刪 worktree 會連共用套件一起刪。 |
| `unslop`、`technical-writing`          | 套用時保留繁體中文語氣，不翻成英文句型                                                              | 文件讀者是繁體中文使用者。                                     |

## 派工給 Codex

派工說明的共同部分在 `docs/agents/codex-dispatch.md`，每次派工都附上，並在開頭要求 Codex 用 `$pstack:poteto-mode` 工作。審查發現新的退件原因時補進那份文件。
