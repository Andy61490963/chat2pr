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

以 `npm view shadcn version` 確定版本後，用 `npx shadcn@4.23.1 view button input dialog tooltip sidebar tabs toggle-group separator scroll-area popover command` 檢視十一個 registry 元件。元件原始碼與依賴來自 [shadcn registry](https://ui.shadcn.com/docs/registry)。本次沿用已安裝的 Radix 與原生控制項。

| 需求 | 看板採用的介面 | 使用位置或選擇依據 |
| --- | --- | --- |
| Button、Input | `button.tsx`、`input.tsx` | 主動作 default，次要 outline 或 secondary，文字 ghost 或 link，危險 destructive。常用 sm 與 md。Input 保留原生表單屬性。 |
| Textarea、Checkbox、Tabs、Separator | `form-controls.tsx` | 已有原生文字區以及 Radix Checkbox、Tabs、Separator。標籤沿用 Label；Tabs 的鍵盤與面板對應由 Radix 負責。 |
| Select | `select.tsx` | 保留 Radix Select 以及需要原生 change 事件的原生選單。選擇器的值與操作事件由原畫面持有。 |
| Dialog、AlertDialog、Tooltip | `dialog.tsx`、`alert-dialog.tsx`、`tooltip.tsx` | Dialog 看詳情，AlertDialog 要求明確回應，Tooltip 補足控制項說明。浮層使用相同表面與焦點樣式。既有業務確認仍沿用 `app/confirm.tsx` 的待處理、取消與確認流程。 |
| Sidebar | `sidebar.tsx` 的 Sidebar、SidebarItem | 保留手機底部導覽、桌面側欄、目前頁面與顯示名稱。registry 的 Sidebar 另含展開、收合與行動版 Sheet；目前看板只需要版面及按鈕。可見頁面、權限與導覽事件由呼叫端提供。 |
| Toggle Group、Scroll Area、Popover、Command | 現階段沿用 Tabs、原生捲動、DropdownMenu、Select | 看板切頁需要面板語意，列表使用原生捲動，現有選單已處理焦點與鍵盤。尚無命令搜尋介面；registry 的 Command 另需 cmdk。 |
| Badge、鍵值列 | `badge.tsx`、`description-list.tsx` | Badge 統一狀態底色與文字，StatusBadge 接領域詞彙。DescriptionList 搭配 DescriptionItem 保留 dl/dt/dd；pairs 可選擇在寬螢幕並排兩組。 |
| 標題、空狀態、工具列 | `layout.tsx` 的 PageHeader、SectionHeader、EmptyState、Toolbar | 區塊標題保留 h2–h4、id、數量及行動按鈕。空狀態說明目前情形與下一步。工具列在窄螢幕換行。 |
| 清單、橫幅 | 同檔 DataList、ListRow、DataListFrame、DataListHeader、ListRowButton、InlineNotice | 群組與專案共用桌面欄頭與可點資料列；成員與記憶清單保留原生清單語意。橫幅的 alert 或 status 角色按原場景指定。 |

## 頁面重複樣式盤點

位置固定在第一階段的起點 `4320bc9`，行號指向 JSX 開始標籤。表中涵蓋頁面殼與 `src/app/*.tsx` 的十二類樣式；工具列列出可換行的動作群，清單列出清單容器及資料列。部分位置已透過 CardTitle、Badge 等元件共用。只更換結構時保留原來的事件、文字、表單值與焦點。

| 樣式家族 | 收斂元件 | 修改前的位置（檔案相對於 `src/`） |
| --- | --- | --- |
| 頁首 | PageHeader | `App.tsx:1096, 1652` |
| 區塊標題 | SectionHeader | `App.tsx:1630`、`app/capacity.tsx:60, 151, 183`、`app/check-environments.tsx:68`、`app/checks.tsx:710`、`app/connection-secrets.tsx:35`、`app/context-evidence.tsx:13`、`app/docker-disk.tsx:213, 295, 336, 378, 410`、`app/egress.tsx:90, 198`、`app/friction.tsx:83`、`app/groups.tsx:641, 751, 844`、`app/inbox.tsx:318, 326, 400, 653, 828`、`app/members.tsx:220, 286`、`app/memory-overview.tsx:39, 63, 110`、`app/pick-list.tsx:60`、`app/project-context.tsx:79, 97`、`app/project-database.tsx:303, 371, 450`、`app/project-ssh.tsx:229, 320, 439`、`app/projects.tsx:293, 300, 314, 501, 718, 937`、`app/run-observer.tsx:68, 177`、`app/settings.tsx:222, 475, 838, 922, 1223, 1304, 1356, 1416, 1434`、`app/shared.tsx:653`、`app/system.tsx:313, 369, 409, 439, 489, 649, 660, 701, 707, 778`、`app/task-clarification.tsx:49, 113`、`app/task-review-panel.tsx:421, 506, 680, 817, 1027, 1041, 1291, 1300, 1387, 1547`、`app/tasks.tsx:168` |
| 狀態標籤 | Badge；任務狀態沿用 StatusBadge 的詞彙對照 | `app/capacity.tsx:161, 196, 211`、`app/chat.tsx:537`、`app/checks.tsx:846, 849, 853, 856`、`app/docker-disk.tsx:220`、`app/egress.tsx:170`、`app/groups.tsx:89, 427, 779`、`app/inbox.tsx:670`、`app/members.tsx:313`、`app/memory-overview.tsx:136`、`app/project-ssh.tsx:254, 257`、`app/projects.tsx:724, 907`、`app/settings.tsx:962, 1109, 1175, 1360`、`app/shared.tsx:341, 586, 654`、`app/system.tsx:212, 465`、`app/task-clarification.tsx:65`、`app/task-review-panel.tsx:982, 1102, 1344` |
| 空狀態 | EmptyState | `app/chat.tsx:126, 326`、`app/groups.tsx:258, 311`、`app/inbox.tsx:557, 599, 902`、`app/projects.tsx:330`、`app/review-workbench.tsx:510, 523`、`app/tasks.tsx:433, 448, 470` |
| 表單列 | Label 搭配 Input、Textarea、Select 或 Checkbox | `app/capacity.tsx:97`、`app/check-environments.tsx:97, 109`、`app/checks.tsx:354, 363, 378, 390, 416, 473, 541, 549, 558, 566`、`app/connection-secrets.tsx:100, 140`、`app/docker-disk.tsx:415, 430, 441, 461, 495, 612`、`app/groups.tsx:277, 567, 579, 603, 679, 851`、`app/inbox.tsx:413, 461`、`app/pick-list.tsx:72`、`app/project-context.tsx:115, 123, 177`、`app/project-database.tsx:178, 378, 476, 483, 492, 517, 551`、`app/project-ssh.tsx:211, 327, 477, 497, 516`、`app/projects.tsx:1285, 1377, 1386, 1399, 1408, 1452, 1465, 1487, 1501, 1546, 1584, 1598, 1625`、`app/settings.tsx:252, 365, 385, 494, 507, 515, 532, 549, 591, 615, 658, 678, 701, 714, 733, 751, 855, 935`、`app/task-actions.tsx:212, 294, 361, 390`、`app/task-branch-picker.tsx:73, 88`、`app/task-clarification.tsx:81, 138`、`app/task-review-panel.tsx:1222, 1339, 1426, 1436`、`app/tasks.tsx:504` |
| 工具列 | Toolbar | `App.tsx:1274`、`app/chat.tsx:132, 295, 366, 533`、`app/checks.tsx:116, 441, 481, 514, 754, 807, 944`、`app/connection-secrets.tsx:103, 121`、`app/docker-disk.tsx:233, 429, 548`、`app/egress.tsx:132`、`app/friction.tsx:92`、`app/groups.tsx:276, 731, 763, 842`、`app/inbox.tsx:276, 317, 611, 758`、`app/memory-overview.tsx:77`、`app/page-notices.tsx:41`、`app/pick-list.tsx:28`、`app/project-context.tsx:193`、`app/project-database.tsx:389, 475, 566`、`app/project-ssh.tsx:249, 270, 340, 408`、`app/projects.tsx:269`、`app/query-report.tsx:91, 143`、`app/settings.tsx:761, 938, 991, 1274`、`app/shared.tsx:754`、`app/task-actions.tsx:302`、`app/task-clarification.tsx:52, 95`、`app/task-review-panel.tsx:754, 1040, 1238, 1267, 1444`、`app/tasks.tsx:297, 502, 634, 689` |
| 清單與清單列 | DataList、ListRow；可點列用 ListRowButton | `App.tsx:1633, 1635, 1718, 1720`、`app/capacity.tsx:155, 157, 187, 189`、`app/chat.tsx:344, 356, 525`、`app/checks.tsx:118, 123, 134, 136, 831, 836, 1066, 1067, 1070, 1074, 1075`、`app/connection-secrets.tsx:38, 99`、`app/context-evidence.tsx:78, 80`、`app/docker-disk.tsx:299, 303, 381, 383, 478, 486, 569, 571, 626, 628`、`app/egress.tsx:126, 128, 166, 168`、`app/friction.tsx:127, 129`、`app/groups.tsx:126, 184, 405, 414, 789, 791, 796, 870`、`app/inbox.tsx:327, 329, 518, 551, 575, 788, 790, 847, 855, 889`、`app/members.tsx:293, 295, 345`、`app/memory-overview.tsx:71, 73, 118, 120`、`app/pick-list.tsx:69, 71`、`app/project-database.tsx:417, 419`、`app/project-ssh.tsx:246, 248, 370, 379`、`app/projects.tsx:154, 158, 657, 659, 731, 732, 735, 736, 944, 946`、`app/review-workbench.tsx:111, 117, 509, 515`、`app/run-observer.tsx:332, 346`、`app/settings.tsx:791, 793, 1084, 1325, 1341`、`app/system.tsx:370, 413, 445, 447, 525, 661, 684, 704, 706`、`app/task-actions.tsx:123, 130, 202, 211`、`app/task-clarification.tsx:119, 121`、`app/task-review-panel.tsx:544, 546, 572, 574, 683, 685, 710, 715, 1078, 1087, 1361, 1363, 1520, 1522, 1532, 1556, 1558, 1563`、`app/tasks.tsx:174` |
| 說明列 | DescriptionList、DescriptionItem | `app/capacity.tsx:126, 128, 138`、`app/groups.tsx:642, 645`、`app/members.tsx:268, 270, 276`、`app/projects.tsx:431, 432, 436, 438, 460, 480, 484, 490`、`app/run-observer.tsx:71, 74, 183, 184, 234, 235, 237, 239, 241, 243, 245, 247, 255`、`app/settings.tsx:1439, 1448`、`app/system.tsx:492, 493, 495, 708, 714`、`app/task-review-panel.tsx:517, 519, 535, 543, 558, 954, 965` |
| 確認對話框 | Dialog 與既有 ConfirmButton；警示式確認用 AlertDialog | `app/checks.tsx:1038`、`app/confirm.tsx:94`、`app/connection-secrets.tsx:156`、`app/egress.tsx:139`、`app/groups.tsx:210`、`app/members.tsx:101, 321`、`app/pick-list.tsx:40`、`app/project-database.tsx:592, 613`、`app/project-ssh.tsx:289`、`app/projects.tsx:577, 765, 968`、`app/settings.tsx:1279`、`app/task-actions.tsx:422` |
| 橫幅提示 | InlineNotice | `App.tsx:1169, 1188, 1207, 1241, 1275, 1311, 1329, 1511, 1661, 1674`、`app/alerts.tsx:382`、`app/capacity.tsx:70, 78`、`app/chat.tsx:121, 314`、`app/check-environments.tsx:77, 85`、`app/checks.tsx:723, 739, 746, 754, 827, 875, 887, 900, 931`、`app/connection-secrets.tsx:28, 171, 187`、`app/docker-disk.tsx:253, 261, 269, 274, 280, 286, 544, 645`、`app/egress.tsx:101, 109`、`app/friction.tsx:120`、`app/groups.tsx:300, 561, 592, 597, 657, 666, 731`、`app/members.tsx:289`、`app/page-notices.tsx:41`、`app/project-context.tsx:96, 221`、`app/project-database.tsx:312, 328, 335, 356, 409, 414, 431, 649, 657, 675`、`app/project-ssh.tsx:241, 263, 361, 367, 526`、`app/projects.tsx:362, 531, 602, 853, 1069, 1133, 1346, 1363, 1565, 1616`、`app/query-report.tsx:134, 159`、`app/review-workbench.tsx:380, 410, 470`、`app/run-observer.tsx:281, 292`、`app/settings.tsx:279, 285, 773, 960, 1240, 1274, 1374`、`app/system.tsx:271, 336, 349`、`app/task-actions.tsx:196, 384`、`app/task-branch-picker.tsx:55, 66`、`app/task-clarification.tsx:151`、`app/task-review-panel.tsx:97, 708, 1148, 1180, 1408`、`app/tasks.tsx:656` |
| 分頁 | Tabs、TabsList、TabsTrigger、TabsContent | `app/projects.tsx:387`、`app/review-workbench.tsx:90`、`app/settings.tsx:1159`、`app/system.tsx:198`、`app/task-review-panel.tsx:1463`、`app/tasks.tsx:607` |
| 側邊導覽 | Sidebar、SidebarItem | `App.tsx:953, 962`、`app/review-workbench.tsx:539` |

## 固定樣式盤點

基底共 380 筆，本階段剩 146 筆。同一工具中的像素或色碼只算一筆，主題宣告的合法原始值另外列出。狀態選擇器不計入任意工具值。

| 類別 | 修改前 | 保留 |
| --- | ---: | ---: |
| 任意工具值 | 175 | 72 |
| 大圓角 | 141 | 49 |
| 行內像素 | 26 | 24 |
| CSS 固定字級、行高、間距與圓角 | 37 | 0 |
| 漸層或毛玻璃 | 1 | 1 |
| 原始色碼 | 0 | 0 |

下表列出基底全部位置。相同行號重複表示同一行有多處；保留項目的欄位、字面值與識別碼見基準檔。

| 基底檔案 | 筆數 | 基底行號 | 保留筆數 |
| --- | ---: | --- | ---: |
| `src/App.tsx` | 30 | 939、949、955、955、971、983、983、997、997、997、1010、1010、1043、1049、1086、1091、1250、1277、1514、1514、1514、1523、1624、1663、1676、1722、1790、1793、1813、1822 | 30 |
| `src/app/alerts.tsx` | 8 | 347、347、357、357、387、393、442、455 | 0 |
| `src/app/capacity.tsx` | 5 | 72、80、155、187、214 | 0 |
| `src/app/chat.tsx` | 15 | 305、383、383、401、432、440、444、473、508、528、539、539、543、548、559 | 0 |
| `src/app/check-environments.tsx` | 2 | 79、85 | 0 |
| `src/app/checks.tsx` | 15 | 128、138、726、741、748、756、794、836、843、860、875、888、900、909、933 | 0 |
| `src/app/context-evidence.tsx` | 3 | 19、21、71 | 0 |
| `src/app/docker-disk.tsx` | 12 | 255、263、269、274、280、286、311、314、339、409、565、593 | 0 |
| `src/app/egress.tsx` | 3 | 103、111、197 | 0 |
| `src/app/friction.tsx` | 2 | 122、127 | 0 |
| `src/app/groups.tsx` | 21 | 128、186、187、319、353、394、397、416、419、419、419、424、464、561、592、597、657、731、789、870、887 | 0 |
| `src/app/inbox.tsx` | 9 | 331、395、432、537、745、949、954、978、1006 | 9 |
| `src/app/members.tsx` | 4 | 228、269、275、289 | 0 |
| `src/app/memory-overview.tsx` | 7 | 46、71、74、77、118、125、128 | 0 |
| `src/app/page-notices.tsx` | 1 | 45 | 1 |
| `src/app/pick-list.tsx` | 1 | 57 | 1 |
| `src/app/project-context.tsx` | 3 | 75、84、96 | 0 |
| `src/app/project-database.tsx` | 6 | 299、314、369、447、502、651 | 0 |
| `src/app/project-ssh.tsx` | 4 | 248、318、381、437 | 0 |
| `src/app/projects.tsx` | 20 | 143、146、160、164、164、164、167、178、196、348、353、393、431、491、498、531、645、856、948、1348 | 0 |
| `src/app/query-report.css` | 26 | 2、12、12、15、18、20、23、29、34、35、44、53、55、56、59、61、61、62、70、74、74、84、92、93、97、102 | 0 |
| `src/app/query-report.tsx` | 12 | 37、37、116、132、163、163、163、224、224、224、233、332 | 0 |
| `src/app/review-workbench.tsx` | 6 | 127、127、127、382、493、493 | 6 |
| `src/app/run-observer.tsx` | 6 | 71、173、211、234、339、348 | 6 |
| `src/app/settings.tsx` | 12 | 279、285、320、594、793、860、896、987、1090、1098、1242、1276 | 12 |
| `src/app/shared.tsx` | 5 | 380、457、457、588、704 | 5 |
| `src/app/system.tsx` | 18 | 338、352、370、413、433、445、451、452、456、492、492、529、547、607、704、708、729、781 | 18 |
| `src/app/task-actions.tsx` | 5 | 132、202、233、294、483 | 5 |
| `src/app/task-clarification.tsx` | 2 | 47、111 | 0 |
| `src/app/task-review-panel.tsx` | 29 | 102、122、126、461、468、481、488、503、576、685、691、708、711、976、1067、1075、1109、1151、1155、1159、1184、1200、1251、1267、1292、1315、1331、1384、1410 | 29 |
| `src/app/tasks.tsx` | 4 | 502、609、673、680 | 0 |
| `src/components/brand.tsx` | 2 | 6、9 | 0 |
| `src/components/ui/button.tsx` | 1 | 7 | 0 |
| `src/components/ui/card.tsx` | 4 | 9、9、22、22 | 0 |
| `src/components/ui/description-list.tsx` | 3 | 15、18、45 | 0 |
| `src/components/ui/dialog.tsx` | 7 | 122、122、122、122、122、124、124 | 0 |
| `src/components/ui/dropdown-menu.tsx` | 4 | 53、53、241、241 | 0 |
| `src/components/ui/form-controls.tsx` | 15 | 34、34、50、50、73、73、73、80、80、98、150、150、152、152、152 | 0 |
| `src/components/ui/input.tsx` | 2 | 10、11 | 0 |
| `src/components/ui/select.tsx` | 6 | 38、38、66、66、80、80 | 0 |
| `src/components/ui/sheet.tsx` | 1 | 36 | 0 |
| `src/components/ui/table.tsx` | 2 | 72、85 | 0 |
| `src/components/ui/tooltip.tsx` | 2 | 56、56 | 0 |
| `src/flow/architecture-flow.js` | 24 | 82、118、119、126、132、142、146、187、199、200、204、207、236、237、240、254、258、259、266、268、282、283、295、299 | 24 |
| `src/styles.css` | 11 | 177、182、223、223、225、225、248、280、298、329、329 | 0 |

基底另有 47 處合法調色宣告，位於 `src/styles.css` 行 12、13、14、15、16、17、18、19、20、20、21、21、22、23、24、25、26、27、28、29、30、31、32、33、34、38、39、40、41、42、43、44、45、47、48、49、50、51、52、53、54、55、56、57、58、59、60。亮暗色共用的語意名稱由這裡取得色值。

## 分階段接手與重跑

開工時以 `gh pr list --state open` 與每張 PR 的 `gh pr diff --name-only` 比對。#269、#270、#274、#275、#277、#281、#282、#283 為當時的開放 PR。這次遷移群組、記憶總覽、專案與連線資料、成員、定期檢查、聊天室、任務與報告，以及系統頁內獨立的容量、使用摩擦、磁碟與網路區塊。各頁保留原有導覽入口。

第二階段依相關 PR 合併後的版本重新盤點：

1. 導覽殼與共用呈現：`src/App.tsx`、`src/app/shared.tsx`、`src/app/page-notices.tsx`。接上 Sidebar、PageHeader，移除舊的共用呈現。
2. 收件匣與審核：`inbox.tsx`、`pick-list.tsx`、`review-workbench.tsx`、`task-review-panel.tsx`、`task-actions.tsx`，以及其他 PR 新增的 `review-queue-list.tsx`。依合併後真實入口驗證鍵盤、捲動與焦點。
3. 系統、設定與執行詳情：`system.tsx`、`settings.tsx`、`run-observer.tsx`。內嵌架構圖使用 `src/flow/architecture-flow.js` 與獨立的 `docs/architecture-flow.html`，需一起驗證圖形縮放、內嵌及獨立視窗兩種外觀。

`node --import tsx scripts/design-tokens.ts` 可重新列出全站違規的檔案、行、欄、原因與樣式，附加 Git revision 可重現歷史盤點。清除違規後從 [基準](../tests/design-tokens.baseline.tsv) 刪除對應列，用 `npx vitest run tests/design-tokens.test.ts` 核對。CI 也會以目標版本檢查每一筆豁免是否原已存在。

展示入口為驗收伺服器的 `/e2e/design-system.html`。執行 `e2e/design-system.spec.ts` 與 `e2e/design-pages.spec.ts` 會產生 375px、1440px 深淺色的元件與頁面截圖。設定 `DESIGN_SHOTS_DIR` 可將 PNG 直接存到比較目錄。
