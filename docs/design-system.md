# 看板設計系統

工作區以紙色表面、墨色文字、鋼色分隔線呈現工單與資料。管理者應能沿著清單掃讀異常、找到下一個操作，再用鍵盤完成工作。三層表面、單一強調色與等寬數字沿用 [#263](https://github.com/Andy61490963/chat2pr/pull/263) 的決策，第一階段將舊版卡片的 12px 圓角收至 6px，移除卡片陰影。

## 選擇代幣

| 用途 | 寫法與尺度 |
| --- | --- |
| 表面 | 頁面用 `bg-background`，有邊界的區塊用 `bg-card`，浮層用 `bg-popover shadow-raised`。內部元素以 `bg-surface` 承接最近一層。深色用亮度區分表面。 |
| 文字、邊線 | 內文用 `text-foreground`，輔助說明用 `text-muted-foreground`，分隔用 `border-border`，控制項用 `border-input`。 |
| 動作與狀態 | 主動作使用 `primary`。運轉、警告、停機、資訊分別使用 `good`、`warn`、`danger`、`info` 搭配同名 `-soft` 表面；文字一併描述狀態。數量使用中性色。 |
| 文字與行高 | `heading-page` 20px、`heading-section` 18px、`text-sm` 14px、`text-xs` 13px、`text-caption` 12px。標題行高 1.3、標籤 1.4、內文 1.5。中文用 Noto Sans TC，數字加 `tabular-nums`。 |
| 間距 | `--spacing` 為 4px。常用 `gap-1/2/3/4` 為 4/8/12/16px，區塊間用 `gap-6`。手機按鈕至少 `min-h-11`（44px）。響應式清單沿用具名欄軌。 |
| 圓角、焦點 | `rounded-none/xs/sm/md` 分別為 0/2/4/6px；互動元件用 `focus-visible:focus-frame`。焦點寬度與偏移共用主題變數。 |

在 [styles.css](../src/styles.css) 的主題中定義尺度及兩種外觀，在元件組合代幣。動態進度、依 SVG 原尺寸計算的縮放寬度繼續由資料決定。Radix 的狀態選擇器及子元素選擇器可搭配具名工具。

## 共用元件與 registry 對照

以 shadcn MCP 的 `view_items_in_registries` 核對下表十一個 registry 元件。首次盤點時 MCP 連線逾時，也以 `npx shadcn@4.23.1 view` 檢視過同一組元件原始碼。本次沿用已安裝的 Radix 與原生控制項。[shadcn registry](https://ui.shadcn.com/docs/registry)

| 需求 | 看板採用的介面 | 使用位置或選擇依據 |
| --- | --- | --- |
| Button、Input | `button.tsx`、`input.tsx` | 主動作 default，次要 outline 或 secondary，文字 ghost 或 link，危險 destructive。常用 sm 與 md。Input 保留原生表單屬性。 |
| Textarea、Checkbox、Tabs、Separator | `form-controls.tsx` | 已有原生文字區以及 Radix Checkbox、Tabs、Separator。標籤沿用 Label；Tabs 的鍵盤與面板對應由 Radix 負責。 |
| Select | `select.tsx` | 保留 Radix Select 以及需要原生 change 事件的原生選單。選擇器的值與操作事件由原畫面持有。 |
| Dialog、Tooltip | `dialog.tsx`、`tooltip.tsx` | 需要確認的操作使用 `app/confirm.tsx` 的 ConfirmButton，保留待處理、取消、確認及焦點還原。浮層共用表面與焦點樣式。 |
| Sidebar、AlertDialog | 第二階段依實際使用處接入 | 側欄由 `App.tsx` 主殼負責，確認由 ConfirmButton 負責。新增元件時連同呼叫端、鍵盤操作與展示一起交付。 |
| Toggle Group、Scroll Area、Popover、Command | 現階段沿用 Tabs、原生捲動、DropdownMenu、Select | 看板切頁需要面板語意，列表使用原生捲動，現有選單已處理焦點與鍵盤。尚無命令搜尋介面；registry 的 Command 另需 cmdk。 |
| Badge、鍵值列 | `badge.tsx`、`description-list.tsx` | Badge 統一狀態底色與文字，StatusBadge 接領域詞彙。DescriptionList 搭配 DescriptionItem 保留 dl/dt/dd；pairs 可選擇在寬螢幕並排兩組。 |
| 標題、空狀態、工具列 | `layout.tsx` 的 PageHeader、SectionHeader、EmptyState、Toolbar | 區塊標題保留 h2–h4、id、數量及行動按鈕。空狀態說明目前情形與下一步。工具列在窄螢幕換行。 |
| 清單、橫幅 | 同檔 DataList、ListRow、DataListFrame、DataListHeader、ListRowButton、InlineNotice | 群組與專案共用桌面欄頭與可點資料列；成員與記憶清單保留原生清單語意。橫幅的 alert 或 status 角色按原場景指定。 |

## 頁面重複樣式盤點

首次盤點採用 `4320bc9` 的頁面殼與 `src/app/*.tsx`。下列括號是各檔案的出現次數，可直接以元件名稱搜尋現行實作。

| 樣式家族 | 收斂元件 | 修改前的檔案與次數（相對於 `src/`） |
| --- | --- | --- |
| 頁首 | PageHeader | `App.tsx`（2） |
| 區塊標題 | SectionHeader | `App.tsx`（1）、`app/capacity.tsx`（3）、`app/check-environments.tsx`（1）、`app/checks.tsx`（1）、`app/connection-secrets.tsx`（1）、`app/context-evidence.tsx`（1）、`app/docker-disk.tsx`（5）、`app/egress.tsx`（2）、`app/friction.tsx`（1）、`app/groups.tsx`（3）、`app/inbox.tsx`（5）、`app/members.tsx`（2）、`app/memory-overview.tsx`（3）、`app/pick-list.tsx`（1）、`app/project-context.tsx`（2）、`app/project-database.tsx`（3）、`app/project-ssh.tsx`（3）、`app/projects.tsx`（6）、`app/run-observer.tsx`（2）、`app/settings.tsx`（9）、`app/shared.tsx`（1）、`app/system.tsx`（10）、`app/task-clarification.tsx`（2）、`app/task-review-panel.tsx`（10）、`app/tasks.tsx`（1） |
| 狀態標籤 | Badge；任務狀態沿用 StatusBadge 的詞彙對照 | `app/capacity.tsx`（3）、`app/chat.tsx`（1）、`app/checks.tsx`（4）、`app/docker-disk.tsx`（1）、`app/egress.tsx`（1）、`app/groups.tsx`（3）、`app/inbox.tsx`（1）、`app/members.tsx`（1）、`app/memory-overview.tsx`（1）、`app/project-ssh.tsx`（2）、`app/projects.tsx`（2）、`app/settings.tsx`（4）、`app/shared.tsx`（3）、`app/system.tsx`（2）、`app/task-clarification.tsx`（1）、`app/task-review-panel.tsx`（3） |
| 空狀態 | EmptyState | `app/chat.tsx`（2）、`app/groups.tsx`（2）、`app/inbox.tsx`（3）、`app/projects.tsx`（1）、`app/review-workbench.tsx`（2）、`app/tasks.tsx`（3） |
| 表單列 | Label 搭配 Input、Textarea、Select 或 Checkbox | `app/capacity.tsx`（1）、`app/check-environments.tsx`（2）、`app/checks.tsx`（10）、`app/connection-secrets.tsx`（2）、`app/docker-disk.tsx`（6）、`app/groups.tsx`（6）、`app/inbox.tsx`（2）、`app/pick-list.tsx`（1）、`app/project-context.tsx`（3）、`app/project-database.tsx`（7）、`app/project-ssh.tsx`（5）、`app/projects.tsx`（13）、`app/settings.tsx`（18）、`app/task-actions.tsx`（4）、`app/task-branch-picker.tsx`（2）、`app/task-clarification.tsx`（2）、`app/task-review-panel.tsx`（4）、`app/tasks.tsx`（1） |
| 工具列 | Toolbar | `App.tsx`（1）、`app/chat.tsx`（4）、`app/checks.tsx`（7）、`app/connection-secrets.tsx`（2）、`app/docker-disk.tsx`（3）、`app/egress.tsx`（1）、`app/friction.tsx`（1）、`app/groups.tsx`（4）、`app/inbox.tsx`（4）、`app/memory-overview.tsx`（1）、`app/page-notices.tsx`（1）、`app/pick-list.tsx`（1）、`app/project-context.tsx`（1）、`app/project-database.tsx`（3）、`app/project-ssh.tsx`（4）、`app/projects.tsx`（1）、`app/query-report.tsx`（2）、`app/settings.tsx`（4）、`app/shared.tsx`（1）、`app/task-actions.tsx`（1）、`app/task-clarification.tsx`（2）、`app/task-review-panel.tsx`（5）、`app/tasks.tsx`（4） |
| 清單與清單列 | DataList、ListRow；可點列用 ListRowButton | `App.tsx`（4）、`app/capacity.tsx`（4）、`app/chat.tsx`（3）、`app/checks.tsx`（11）、`app/connection-secrets.tsx`（2）、`app/context-evidence.tsx`（2）、`app/docker-disk.tsx`（10）、`app/egress.tsx`（4）、`app/friction.tsx`（2）、`app/groups.tsx`（8）、`app/inbox.tsx`（10）、`app/members.tsx`（3）、`app/memory-overview.tsx`（4）、`app/pick-list.tsx`（2）、`app/project-database.tsx`（2）、`app/project-ssh.tsx`（4）、`app/projects.tsx`（10）、`app/review-workbench.tsx`（4）、`app/run-observer.tsx`（2）、`app/settings.tsx`（5）、`app/system.tsx`（9）、`app/task-actions.tsx`（4）、`app/task-clarification.tsx`（2）、`app/task-review-panel.tsx`（18）、`app/tasks.tsx`（1） |
| 說明列 | DescriptionList、DescriptionItem | `app/capacity.tsx`（3）、`app/groups.tsx`（2）、`app/members.tsx`（3）、`app/projects.tsx`（8）、`app/run-observer.tsx`（13）、`app/settings.tsx`（2）、`app/system.tsx`（5）、`app/task-review-panel.tsx`（7） |
| 確認對話框 | Dialog 與 ConfirmButton | `app/checks.tsx`（1）、`app/confirm.tsx`（1）、`app/connection-secrets.tsx`（1）、`app/egress.tsx`（1）、`app/groups.tsx`（1）、`app/members.tsx`（2）、`app/pick-list.tsx`（1）、`app/project-database.tsx`（2）、`app/project-ssh.tsx`（1）、`app/projects.tsx`（3）、`app/settings.tsx`（1）、`app/task-actions.tsx`（1） |
| 橫幅提示 | InlineNotice | `App.tsx`（10）、`app/alerts.tsx`（1）、`app/capacity.tsx`（2）、`app/chat.tsx`（2）、`app/check-environments.tsx`（2）、`app/checks.tsx`（9）、`app/connection-secrets.tsx`（3）、`app/docker-disk.tsx`（8）、`app/egress.tsx`（2）、`app/friction.tsx`（1）、`app/groups.tsx`（7）、`app/members.tsx`（1）、`app/page-notices.tsx`（1）、`app/project-context.tsx`（2）、`app/project-database.tsx`（10）、`app/project-ssh.tsx`（5）、`app/projects.tsx`（10）、`app/query-report.tsx`（2）、`app/review-workbench.tsx`（3）、`app/run-observer.tsx`（2）、`app/settings.tsx`（7）、`app/system.tsx`（3）、`app/task-actions.tsx`（2）、`app/task-branch-picker.tsx`（2）、`app/task-clarification.tsx`（1）、`app/task-review-panel.tsx`（5）、`app/tasks.tsx`（1） |
| 分頁 | Tabs、TabsList、TabsTrigger、TabsContent | `app/projects.tsx`（1）、`app/review-workbench.tsx`（1）、`app/settings.tsx`（1）、`app/system.tsx`（1）、`app/task-review-panel.tsx`（1）、`app/tasks.tsx`（1） |
| 側邊導覽 | 由主殼管理，第二階段收斂 | `App.tsx`（2）、`app/review-workbench.tsx`（1） |

## CI 檢查與既有基準

掃描器讀取 `src/` 及 `shared/` 的前端來源。TypeScript／JSX 依語法位置判斷樣式，CSS 依宣告與 `@apply` 判斷。CI 會列出檔案、當前行欄、樣式與原因。

| 位置 | 會攔下的寫法 |
| --- | --- |
| 工具類別 | 任意值 `p-[7px]`、`grid-cols-[…]`、`[overflow-wrap:anywhere]`、`p-(--gap)`，預設色盤如 `bg-red-500`、`text-white`，超出字級的 `text-5xl`、大圓角、非浮層陰影、漸層及毛玻璃。 |
| 行內樣式 | 固定尺寸含非零數字、px、rem、em，原始色碼、色名，以及直接指定動態寬度等設計值。資料驅動的樣式須使用有明確用途的 CSS 變數。 |
| 樣式表 | 語意代幣之外的原始色值（含具名顏色、hex、RGB、HSL、OKLCH）、固定字級／間距／圓角、`font` 簡寫、漸層與毛玻璃。只有 `src/styles.css` 的主題、根元素及深色主題代幣可以定義原始色值。 |
| 產生的 CSS | Tailwind 主題先清除預設色盤、字級、圓角與陰影，再宣告看板使用的代幣。編譯測試同時驗證允許與禁止的候選類別。 |

Radix 狀態與子元素選擇器、媒體查詢斷點、IntersectionObserver 的 `rootMargin`、連結錨點、工單編號屬於選擇條件或資料。數字間距工具依 `--spacing` 的倍數運作；間距是否適合資料密度仍須看畫面。渲染後的對比、觸控範圍與版面由瀏覽器驗收檢查。第三方套件、應用程式執行時載入的圖形內容及 `src/`、`shared/` 以外的文件不屬於這份來源盤點。

掃描器可追蹤同檔宣告，識別 JSX 屬性、`cn`、`clsx`、`cva` 與直接設定 DOM 樣式的語法。跨檔函式回傳的類別、執行期拼出的完整類別，以及經 `{...props}` 隱含傳入的屬性須由審查者核對。具名資料變數按檔案登記在 `scripts/design-style-context.ts`。磁碟的 `--disk-used-width` 取自容量比例，查詢報告的 `--diagram-width` 取自 SVG 實測寬度與使用者縮放倍率，進度條的 `--progress-offset` 取自目前的完成比例。

## 其他 PR 遇到 token 檢查失敗時怎麼改

1. 先把分支同步到最新主線。執行 `npx vitest run tests/design-tokens.test.ts`，從「新增的樣式」找到檔名、當前行欄與值。
2. 優先選用同類元件或現有工具。若欄位配置確實不同，在 `src/styles.css` 定義用途清楚的欄軌，使用既有間距與數值比例，再更新本表和展示。
3. 清除舊項目後執行 `node --import tsx scripts/design-tokens.ts --write`，重新跑該測試。比對鍵是檔案、原因、值和來源行內容的指紋。兩筆相同樣式按出現次數核對。移行不影響結果，複製或換成另一個任意值都會失敗。
4. 每張 PR 用本次合併提交的第一個父版本核對。首次導入時，掃描該版本取得可保留的項目；主線已有基準時，只接受刪減。批次推送到主線時從該批推送前的提交比對，涵蓋整批提交。

| 舊寫法或用途 | 使用方式 |
| --- | --- |
| `grid-cols-[minmax(0,1fr)_auto]` | `grid-cols-action`。群組、專案欄頭和列分別重用 `grid-cols-group`、`grid-cols-project`；鍵值列用 DescriptionList。 |
| `rounded-lg`、`rounded-xl` | 區塊用 `rounded-md`（6px），控制項可用 `rounded-sm`（4px）。清單資料列用細分隔線。 |
| `[overflow-wrap:anywhere]` | `wrap-anywhere`。 |
| `text-[14px]`、`p-[12px]` | `text-sm`、`p-3`。頁首使用 PageHeader 或 `heading-page`。 |
| `bg-red-500 text-white`、`shadow-2xl` | 失敗狀態使用 Badge 或 `bg-danger-soft text-danger`；浮層可用 `shadow-raised`，一般列表以分隔線區隔。 |

## 固定樣式盤點

盤點數字依同一版掃描器計算。每一筆紀錄一個樣式，同一工具中的色碼或單位計一次。逐項原因和來源識別見[基準清單](../tests/design-tokens.baseline.tsv)。

主線 `cd69ce1` 共 426 筆，本輪保留 164 筆。下表記錄這次盤點，後續各分支以基準清單查詢即時數量。

| 原因 | 主線 | 本輪保留 |
| --- | ---: | ---: |
| 任意工具值須改用具名 token | 184 | 74 |
| 動態樣式須使用已登記的 CSS 變數 | 20 | 17 |
| 只有浮層可用陰影代幣 | 14 | 0 |
| 固定字級、間距或圓角須改用 token | 58 | 21 |
| 大圓角須改用規範圓角 | 141 | 48 |
| 漸層或毛玻璃須改用單色表面 | 1 | 1 |
| 行內像素須改用尺寸 token | 5 | 3 |
| 預設色盤須改用語意色 | 3 | 0 |

| 檔案 | 主線 | 本輪保留 |
| --- | ---: | ---: |
| `src/App.tsx` | 31 | 31 |
| `src/app/alerts.tsx` | 8 | 0 |
| `src/app/capacity.tsx` | 5 | 0 |
| `src/app/chat.tsx` | 15 | 0 |
| `src/app/check-environments.tsx` | 2 | 0 |
| `src/app/checks.tsx` | 15 | 0 |
| `src/app/context-evidence.tsx` | 3 | 0 |
| `src/app/docker-disk.tsx` | 13 | 0 |
| `src/app/egress.tsx` | 3 | 0 |
| `src/app/friction.tsx` | 2 | 0 |
| `src/app/groups.tsx` | 24 | 0 |
| `src/app/inbox.tsx` | 10 | 10 |
| `src/app/members.tsx` | 4 | 0 |
| `src/app/memory-overview.tsx` | 7 | 0 |
| `src/app/page-notices.tsx` | 1 | 1 |
| `src/app/pick-list.tsx` | 1 | 1 |
| `src/app/project-context.tsx` | 3 | 0 |
| `src/app/project-database.tsx` | 6 | 0 |
| `src/app/project-ssh.tsx` | 4 | 0 |
| `src/app/projects.tsx` | 22 | 0 |
| `src/app/query-report.css` | 26 | 0 |
| `src/app/query-report.tsx` | 14 | 0 |
| `src/app/review-workbench.tsx` | 6 | 6 |
| `src/app/run-observer.tsx` | 6 | 6 |
| `src/app/settings.tsx` | 12 | 12 |
| `src/app/shared.tsx` | 5 | 4 |
| `src/app/system.tsx` | 20 | 20 |
| `src/app/task-actions.tsx` | 5 | 5 |
| `src/app/task-clarification.tsx` | 2 | 0 |
| `src/app/task-review-panel.tsx` | 29 | 29 |
| `src/app/tasks.tsx` | 5 | 0 |
| `src/components/brand.tsx` | 2 | 0 |
| `src/components/ui/button.tsx` | 2 | 0 |
| `src/components/ui/card.tsx` | 5 | 0 |
| `src/components/ui/description-list.tsx` | 3 | 0 |
| `src/components/ui/dialog.tsx` | 8 | 0 |
| `src/components/ui/dropdown-menu.tsx` | 7 | 0 |
| `src/components/ui/form-controls.tsx` | 20 | 0 |
| `src/components/ui/input.tsx` | 3 | 0 |
| `src/components/ui/select.tsx` | 9 | 0 |
| `src/components/ui/sheet.tsx` | 2 | 0 |
| `src/components/ui/table.tsx` | 2 | 0 |
| `src/components/ui/tooltip.tsx` | 3 | 0 |
| `src/flow/architecture-flow.js` | 39 | 39 |
| `src/styles.css` | 12 | 0 |


## 分階段接手與重跑

本階段遷移群組、記憶總覽、專案與連線、成員、定期檢查、聊天室、任務及報告，另包含系統頁內的容量、使用摩擦、磁碟與網路區塊。第二輪核對的平行 PR 包含 #269、#270、#274、#275、#277、#282、#283。#274 與 #283 已先合併，#277 仍在審查。同步 #283 後重新產生基準，164 筆的內容逐筆相同。重新套用主線時，兩個來自 #274 的 `[overflow-wrap:anywhere]` 分別位於收件匣與系統頁，替換方式見上表。主殼由平行 PR 維護，共用入口只調整 Empty 與 SectionTitle 兩個轉接處。

第二階段依合併後的版本處理以下檔案，估計 2 至 4 個人日，包含鍵盤與版面驗收。

1. 導覽殼與通知的 `src/App.tsx`、`src/app/shared.tsx`、`src/app/page-notices.tsx`。整合 PageHeader 和實際的側欄入口。
2. 收件匣及審核的 `inbox.tsx`、`pick-list.tsx`、`review-workbench.tsx`、`task-review-panel.tsx`、`task-actions.tsx`，以及其他 PR 新增的 `review-queue-list.tsx`。如需警示式確認，連同真正的呼叫端導入。
3. 系統、設定及紀錄的 `system.tsx`、`settings.tsx`、`run-observer.tsx`。獨立架構圖的 `src/flow/architecture-flow.js` 及 `docs/architecture-flow.html` 需一併驗證內嵌、獨立視窗與縮放。

驗收伺服器的展示入口為 `/e2e/design-system.html`。更新[展示元件](../e2e/design-system-gallery.tsx)後，執行[元件操作與截圖測試](../e2e/design-system.spec.ts)及[頁面對照測試](../e2e/design-pages.spec.ts)。PR 的「設計系統前後截圖」工作會保留「看板畫面對照」成品 14 天。下載後可對照「改版前」與「改版後」相同檔名的 PNG，`新增畫面.md` 列出只有新版才有的截圖。設定 `DESIGN_SHOTS_DIR` 可在驗收環境指定輸出位置。
