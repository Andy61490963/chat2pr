import { describe, expect, it } from "vitest";
import { classifyRisk } from "../server/policy.js";

describe("呈現語義的完整消耗與請求隔離", () => {
  const labels = ["Order Detail", "Batch Memo", "Custom_X"];
  it.each(labels)("欄寬續句及壓縮下限仍引用同一已明定欄位：%s", (label) => {
    for (const size of [280, 397.5]) {
      for (const cause of ["螢幕縮小", "可視寬度不足"]) {
        for (const verb of ["壓縮", "縮減", "縮窄"]) {
          expect(
            classifyRisk(
              `將 ${label} 欄位寬度設為${size}px。${label} 表頭與各資料列對齊。手機窄螢幕下仍維持目標欄寬，並可透過水平捲動查看其他欄位。圖片所示三筆 ${label} 文字可完整閱讀。${label} 欄位不因${cause}而${verb}至${size}px以下。保留登入功能。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
  });
  it.each([
    "手機窄螢幕下仍維持目標欄寬。保留登入功能。",
    "將 Batch Memo 欄位改為320px。保留登入功能。手機窄螢幕下仍維持目標欄寬。",
    "Batch Memo 表頭與各資料列對齊。手機仍維持目標欄寬。保留登入功能。",
    "Batch Memo 欄位寬度設為320px。Batch Memo 欄位寬度設為360px。手機仍維持目標欄寬。保留登入功能。",
    "Batch Memo 欄位寬度設為320px。Batch Memo 欄位不因螢幕縮小而縮減至300px以下。保留登入功能。",
    "Batch Memo 欄位寬度設為320px。Order Detail 欄位不因螢幕縮小而縮減至320px以下。保留登入功能。",
  ])("目標與數值以下仍需要緊鄰欄位和同一唯一規格：%s", (text) => {
    expect(classifyRisk(text, [])).toContain("敏感");
  });
  it.each([
    "手機仍維持目標權限",
    "手機仍維持目標欄寬並改寫甲組資料",
    "Batch Memo 欄位不因權限不足而縮窄",
    "Batch Memo 欄位不因可視資料不足而取得能力",
    "Batch Memo 欄位不縮減至320px以下並取消驗證",
    "圖片所示三筆 Guest 文字可完整閱讀",
    "圖片所示三筆甲組資料可完整閱讀",
  ])("新的省略主詞與壓縮字詞不豁免未知主體和操作：%s", (payload) => {
    const known = "將 Batch Memo 欄位改為320px。";
    expect(classifyRisk(known + payload + "。保留登入功能。", [])).toContain(
      "敏感",
    );
  });
  it.each(labels)(
    "欄頭與已定義寬度下限、圖片資料保留採有限組合：%s",
    (label) => {
      for (const size of [280, 397.5]) {
        for (const image of ["圖片", "截圖"]) {
          for (const operation of ["替換進", "寫入", "匯入", "套用到"]) {
            expect(
              classifyRisk(
                `將 ${label} 欄位寬度設為${size}px。欄頭與各資料列對齊。圖片所示的三筆 ${label} 內容完整可讀。其他欄位的內容與既有功能維持正常，登入功能不受影響。不將${image}中的測試資料${operation}系統。手機上仍可水平捲動表格，完整查看所有欄位及 ${label} 內容。${label} 欄位不被壓縮至小於${size}px。`,
                [],
              ),
            ).toBeNull();
          }
        }
      }
    },
  );
  it.each([
    "Batch Memo 欄位不被壓縮至小於320px。保留登入功能。",
    "Batch Memo 欄位寬度設為360px。Batch Memo 欄位不被壓縮至小於320px。保留登入功能。",
    "Batch Memo 欄位寬度設為360px。Order Detail 欄位不被壓縮至小於360px。保留登入功能。",
    "Batch Memo 欄位寬度設為360px。Batch Memo 欄位寬度設為320px。Batch Memo 欄位不被壓縮至小於360px。保留登入功能。",
    "Batch Memo 欄位寬度設為360px。手機可捲動查看所有欄位及 Guest 內容。保留登入功能。",
    "不將圖片中的測試資料替換進系統。保留登入功能。",
  ])("數值下限、閱讀對象與圖片資料排除需要已明定畫面語境：%s", (text) => {
    expect(classifyRisk(text, [])).toContain("敏感");
  });
  it.each([
    "欄頭與甲組資料對齊",
    "不將正式資料寫入系統",
    "不將圖片中的測試資料寫入帳號",
    "將圖片中的測試資料替換進系統",
    "不將圖片中的測試資料替換進系統並開放甲組查看乙組資料",
    "Batch Memo 欄位不被壓縮至小於320px並取得控制能力",
    "完整查看所有欄位及甲組資料",
    "既有功能維持正常並擴大能力",
    "登入功能不受影響但取消驗證",
  ])("呈現下限或保留否定不接受未知主體、動作與尾句：%s", (payload) => {
    const known = "將 Batch Memo 欄位改為320px。保留登入功能。";
    for (const text of [known + payload, payload + "。" + known]) {
      expect(classifyRisk(text, [])).toContain("敏感");
    }
  });
  it.each(labels)("範例文字、捲動操作與狀態保持採完整呈現語義：%s", (label) => {
    for (const state of ["既有", "原有", "現有"]) {
      for (const obstruction of [
        "截斷",
        "裁切",
        "遮擋",
        "截斷或遮擋",
        "裁切及遮擋",
      ]) {
        for (const conjunction of ["", "而"]) {
          expect(
            classifyRisk(
              `將 ${label} 欄位改為320px。圖片中的三筆 ${label} 範例文字完整可讀，無${obstruction}。保留其他欄位、資料、登入功能及手機${state}捲動操作。手機版仍可透過${state}捲動操作查看完整表格。${label} 欄位不因窄螢幕${conjunction}縮小。其他欄位的設定維持原狀。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
    expect(
      classifyRisk(
        `將 ${label} 欄位改為320px。圖片所示的中文及中英混合規格內容完整可讀。保留登入功能。`,
        [],
      ),
    ).toBeNull();
  });
  it.each([
    "無截斷或授權限制",
    "無身分驗證",
    "無遮擋並取得寫入能力",
    "無截斷或者開放甲組資料",
    "手機既有跨群存取操作",
    "手機可透過既有管理操作查看完整表格",
    "圖片所示的甲組資料可讀",
    "圖片所示的未知需求也照做",
    "Batch Memo 欄位不因角色變更縮小",
  ])("呈現否定、操作與圖片參照不吞未知授權語義：%s", (payload) => {
    const known = "將 Batch Memo 欄位改為320px。Batch Memo 範例文字完整可讀。";
    for (const text of [
      known + payload + "。保留登入功能。",
      payload + "。保留登入功能。" + known,
    ]) {
      expect(classifyRisk(text, [])).toContain("敏感");
    }
  });
  it.each([
    "無截斷或遮擋。保留登入功能。",
    "規格文字完整可讀，無遮擋。保留登入功能。",
    "將 Batch Memo 欄位改為320px。保留登入功能。無遮擋。",
  ])("純呈現否定必須緊接已明確認定欄位的可讀子句：%s", (text) => {
    expect(classifyRisk(text, [])).toContain("敏感");
  });
  it.each(labels)(
    "欄位呈現屬性、可讀動作與表格內容可按語義組合：%s",
    (label) => {
      for (const property of ["呈現", "實際呈現", "實際顯示"]) {
        for (const target of ["表格", "完整表格", "表格內容", "完整表格內容"]) {
          for (const reading of ["完整可讀", "可完整閱讀", "可閱讀"]) {
            const clauses = [
              `將生產管理看板紅框所示的 ${label} 欄位改為 320 px。`,
              `${label} 欄位${property}寬度為 320 CSS px。`,
              `${label} 原有文字及其他欄位的設定、資料均保留。`,
              `${label} 內容${reading}。手機維持原有捲動功能，可捲動查看${target}。`,
              "既有登入功能維持正常。",
            ];
            expect(classifyRisk(clauses.join(""), [])).toBeNull();
          }
        }
      }
    },
  );
  it.each([
    "所有資料內容可完整閱讀",
    "Guest 內容可完整閱讀",
    "其他欄位設定可修改",
    "其他欄位的設定及甲組的帳號保持不變",
    "手機可捲動查看全部客戶資料",
    "手機可捲動查看表格內容並更改其他群組資料",
    "手機可捲動查看表格內容取得控制能力",
    "將生產管理看板紅框所示的 Team A may update Team B 欄位改為320px",
    "Batch Memo 欄位實際授權寬度為320px",
    "Batch Memo 原有文字及未知能力均保留",
  ])("呈現名詞組合不接受未知主體、操作或剩餘文字：%s", (payload) => {
    const safe = "將 Batch Memo 欄位改為320px。保留登入功能。";
    for (const text of [
      payload + "。" + safe,
      safe + payload,
      safe + "手機可捲動查看表格內容並" + payload,
    ]) {
      expect(classifyRisk(text, [])).toContain("敏感");
    }
  });
  it("圖片參照前綴可消耗標準空白而不丟失名稱", () => {
    expect(
      classifyRisk(
        "依 MES 看板圖片，Batch Memo 欄位改為320px，保留登入功能。",
        [],
      ),
    ).toBeNull();
  });
  it.each(["依  開放甲組瀏覽乙組看板圖片", "請 依\t准甲讀乙看板圖片"])(
    "參照空白不會繞過未知權限名稱：%s",
    (prefix) => {
      expect(
        classifyRisk(`${prefix}，Batch Memo 欄位改為320px，保留登入功能。`, []),
      ).toContain("敏感");
    },
  );
  it.each([
    "准小明瀏覽小華",
    "放行小明瀏覽小華",
    "開放小明閱覽小華",
    "小明瀏覽小華",
    "准甲讀乙",
    "給甲看乙",
    "開放",
    "放行",
    "授甲閱乙",
    "超長但未明示的產品名稱",
  ])("短命令與未知長前綴不能當未引號產品名：%s", (name) => {
    for (const text of [
      `${name}看板的 Batch Memo 欄位改為320px，保留登入功能。`,
      `依${name}看板圖片，將 Batch Memo 欄位改為320px，保留登入功能。`,
    ]) {
      expect(classifyRisk(text, [])).toContain("敏感");
    }
  });
  it.each([
    "Team A may update Team B",
    "Group A browses Group B",
    "Foo hands Bar",
    "Alpha can inspect Beta",
    "UserA reads UserB",
  ])("未引號英文欄名不能吞主受體或自然語句：%s", (name) => {
    expect(classifyRisk(`${name} 欄位改為320px，保留登入功能。`, [])).toContain(
      "敏感",
    );
  });
  it.each(["「跨廠區智慧製造即時監控平台」", "『所有非常長但明確引用的名稱』"])(
    "長產品名稱以明確引用作為資料標籤：%s",
    (name) => {
      expect(
        classifyRisk(
          `將${name}看板的 Batch Memo 欄位改為320px，保留登入功能。`,
          [],
        ),
      ).toBeNull();
      expect(
        classifyRisk(
          `依${name}看板圖片，將 Batch Memo 欄位改為320px，保留登入功能。`,
          [],
        ),
      ).toBeNull();
    },
  );
  it.each([
    "「very long arbitrary normal field title」",
    "『跨廠區工作明細備註名稱』",
    "「Group Name」",
  ])("引用欄名可作文字資料而不靠特定欄名：%s", (name) => {
    expect(
      classifyRisk(`將${name}欄位改為320px，保留登入功能。`, []),
    ).toBeNull();
  });
  it.each(["「登入功能」", "『管理權限』", "「secret token」"])(
    "引用名稱不會遮罩原文敏感詞：%s",
    (name) => {
      expect(
        classifyRisk(`將${name}欄位改為320px，保留登入功能。`, []),
      ).toContain("敏感");
    },
  );
  it.each([
    "開放甲組瀏覽乙組",
    "放行甲組瀏覽乙組",
    "准甲組瀏覽乙組",
    "甲組瀏覽乙組",
  ])("位置名稱不能吞未列舉的跨群關係：%s", (location) => {
    expect(
      classifyRisk(
        `${location}看板的 Batch Memo 欄位改為320px，保留登入功能`,
        [],
      ),
    ).toContain("敏感");
  });
  it.each([
    ["甲組", "乙組"],
    ["A群", "B群"],
    ["第一團隊", "第二團隊"],
    ["研發部門", "客服部門"],
    ["使用者甲", "使用者乙"],
    ["角色X", "角色Y"],
    ["帳號A", "帳號B"],
    ["Team A", "Team B"],
    ["Group One", "Group Two"],
    ["User A", "User B"],
    ["Role X", "Role Y"],
    ["TeamA", "TeamB"],
  ])("主受體詞決定邊界，不依賴中間動詞：%s／%s", (subject, object) => {
    for (const verb of [
      "瀏覽",
      "統籌",
      "調用",
      "連結",
      "XYZ",
      "handles",
      "sees",
    ]) {
      for (const label of labels) {
        expect(
          classifyRisk(
            `${subject} ${verb} ${object}看板的 ${label} 欄位改為320px，保留登入功能`,
            [],
          ),
        ).toContain("敏感");
      }
    }
  });
  it.each(["群組作業", "角色設定", "帳號明細", "Team A"])(
    "位置名稱像主體敘述時保守交人工：%s",
    (location) => {
      expect(
        classifyRisk(
          `將${location}看板的 Part Spec 欄位改為320px，保留登入功能`,
          [],
        ),
      ).toContain("敏感");
    },
  );
  it.each([
    "甲組可管理乙組",
    "甲組可以修改乙組",
    "丙組能夠查看丁組",
    "甲組得以操作乙組",
    "甲組負責維護乙組",
    "甲組具有全部控制能力",
    "甲組更新乙組資料",
    "Team A may update Team B",
    "Team A can manage Team B",
    "Team A controls Team B",
  ])("能力或資料操作不能藏在看板名稱：%s", (location) => {
    for (const name of ["Part Spec", "Order Detail", "Custom_X"]) {
      expect(
        classifyRisk(
          `${location}看板的 ${name} 欄位寬度改為360px；保留登入功能`,
          [],
        ),
      ).toContain("敏感");
    }
  });
  it.each([
    "生產管理",
    "設備控制",
    "青鳥 MES",
    "Factory Line 3",
    "產品資訊",
    "製造現場",
  ])("一般產品名稱與引號欄名仍可用：%s", (location) => {
    expect(
      classifyRisk(
        `將${location}看板的「批次規格」欄位改為360px，保留登入功能。`,
        [],
      ),
    ).toBeNull();
  });
  it.each(labels)("看板、表格及欄位位置依完整詞組消耗：%s", (label) => {
    for (const board of ["測試看板", "青鳥 MES 看板", "現場 LINE 2 看板"]) {
      for (const table of ["", "表格", "的表格"]) {
        for (const field of ["欄", "欄位", "表頭"]) {
          expect(
            classifyRisk(
              `將${board}${table}的 ${label} ${field}改為360px，保留登入功能。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
  });
  it.each(labels)("已明示欄位的寬度或文字可承接完整捲動語義：%s", (label) => {
    for (const previous of [
      `手機窄螢幕下 ${label} 欄仍維持360px`,
      `${label} 欄位文字完整可讀`,
      `${label} 欄位上下對齊`,
    ]) {
      for (const direction of ["水平", "橫向"]) {
        expect(
          classifyRisk(
            `將 ${label} 欄位改為360px。保留登入功能。${previous}，並可正常${direction}捲動查看完整表格。`,
            [],
          ),
        ).toBeNull();
      }
    }
  });
  it.each(labels)("寬度呈現續句與欄位文字的防裁切因果組合：%s", (label) => {
    for (const verb of ["為", "顯示為", "呈現為"]) {
      for (const qualifier of ["", "實際"]) {
        for (const clipping of ["截斷", "裁切"]) {
          expect(
            classifyRisk(
              `保留登入功能。${label} 欄位寬度一致，${qualifier}${verb}360px。${label} 的文字不因${clipping}而無法完整閱讀。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
  });
  it.each([
    "保留登入功能。可水平捲動查看完整表格。",
    "保留登入功能。欄寬為360px，並可水平捲動查看完整表格。",
    "保留登入功能。文字完整可讀，並可水平捲動查看完整表格。",
    "保留登入功能。Order Detail 欄位為360px，並可正常讀取所有欄位。",
    "保留登入功能。Order Detail 欄位為360px，並可水平捲動查看甲組資料。",
    "保留登入功能。Order Detail 欄位為360px，甲組能水平捲動查看完整表格。",
    "保留登入功能。Order Detail 欄位為360px，並可查看完整表格。",
    "保留登入功能。實際呈現為360px。",
    "保留登入功能。Order Detail 欄位寬度一致，實際授權為360px。",
    "保留登入功能。Order Detail 欄位的文字不因權限限制而無法完整閱讀。",
    "保留登入功能。Order Detail 欄位的資料不因截斷而無法完整讀取。",
    "保留登入功能。將青鳥 MES 看板所有資料的 Order Detail 欄位設為360px。",
  ])("呈現位置與續句不能遺失未知主體、能力或原因：%s", (text) => {
    expect(classifyRisk(text, [])).toContain("敏感");
  });
  it.each(labels)("捲動修飾語仍限於表格呈現動作：%s", (label) => {
    for (const subject of ["手機", "手機畫面", "表格", "所有欄位"]) {
      for (const mood of ["可", "能", "仍可", "皆能"]) {
        for (const direction of ["水平", "橫向"]) {
          expect(
            classifyRisk(
              `將 ${label} 欄位改為 360 px。保留登入功能。${subject}${mood}正常${direction}捲動並查看所有欄位。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
  });
  it.each(labels)("已定義欄位的多語文字與防裁切語義：%s", (label) => {
    for (const language of [
      "中文及英文",
      "中文與中英文混合",
      "英文和中英混合",
      "中英文混合",
    ]) {
      for (const cause of ["", "因欄寬調整", "因欄寬調整而"]) {
        for (const passive of ["", "遭", "被", "會"]) {
          expect(
            classifyRisk(
              `將 ${label} 欄位改為 360 px。保留登入功能。${label} ${language}內容完整可讀，不${cause}${passive}截斷。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
  });
  it.each(labels)("資料主詞的量詞只能搭配保留原樣：%s", (label) => {
    for (const quantity of ["", "所有", "全部"]) {
      for (const modifier of ["", "既有", "原有", "現有", "顯示"]) {
        for (const noun of ["資料", "資料內容"]) {
          expect(
            classifyRisk(
              `將 ${label} 欄位改為 360 px。其他欄位及${quantity}${modifier}${noun}維持原樣，保留登入功能。`,
              [],
            ),
          ).toBeNull();
        }
      }
    }
  });
  it.each([
    "甲組可正常修改乙組資料",
    "手機可正常讀取所有資料",
    "表格可正常授權所有欄位",
    "所有資料內容可讀",
    "全部既有資料可寫",
    "全部資料內容可正常讀取",
    "手機可正常水平捲動並讀取所有資料",
    "手機可正常水平捲動查看其他群組資料",
    "Order Detail 中文及任意指令內容完整可讀",
    "Order Detail 中文及中英文混合內容完整可寫",
    "Order Detail 內容完整可讀，不因撤銷授權而截斷",
    "Order Detail 內容完整可讀，不因欄寬調整而略過驗證",
    "不因欄寬調整遭截斷",
    "所有資料內容取得操作能力",
  ])("新增呈現修飾詞不豁免未知能力或無主詞語境：%s", (payload) => {
    const safe = "將 Order Detail 欄位改為 360 px。保留登入功能。";
    for (const text of [
      payload + "。" + safe,
      safe + payload + "。",
      safe + "手機可正常水平捲動並" + payload + "。",
    ]) {
      expect(classifyRisk(text, [])).toContain("敏感");
    }
  });
  it.each(["所有資料內容", "全部既有資料", "所有顯示資料"])(
    "沒有明確畫面欄位時不替全體資料推定範圍：%s",
    (subject) => {
      expect(classifyRisk(`保留${subject}及登入功能。`, [])).toContain("敏感");
    },
  );
  it.each(labels)("欄位捲動與保持原樣的連接詞不依賴特定欄名：%s", (label) => {
    for (const join of ["及", "與", "和"]) {
      for (const noun of ["內容", "資料"]) {
        expect(
          classifyRisk(
            `將 ${label} 欄位改為 360 px。其他欄位、資料內容及登入功能維持原行為。手機螢幕下可水平捲動表格，查看所有欄位${join}完整${noun}。${label} 欄位不因畫面變窄而縮小。`,
            [],
          ),
        ).toBeNull();
        expect(
          classifyRisk(
            `保留登入功能。手機螢幕下可水平捲動表格，查看所有欄位${join}甲組資料。`,
            [],
          ),
        ).toContain("敏感");
      }
    }
  });
  it.each(labels)("同一語義可套用任意已明確定義欄名：%s", (label) => {
    expect(
      classifyRisk(
        `將 ${label} 欄位寬度一致設為 360 px。保留登入功能。${label} 的中英文規格內容完整可讀。手機窄螢幕下，${label} 欄位維持指定寬度，表格能水平捲動以查看所有欄位。`,
        [],
      ),
    ).toBeNull();
    expect(classifyRisk(`${label} 內容完整可讀。保留登入功能。`, [])).toContain(
      "敏感",
    );
  });
  it("合法連接詞承接完整語義，登入例外只遮罩自己的子句", () => {
    expect(
      classifyRisk("將 Order Detail 欄位改為 360 px 並保留登入功能。", []),
    ).toBeNull();
    expect(
      classifyRisk("保留登入功能並將 Order Detail 欄位改為 360 px。", []),
    ).toBeNull();
    expect(
      classifyRisk("將 Order Detail 欄位改為 360 px，並保留登入功能。", []),
    ).toBeNull();
    expect(
      classifyRisk("將「登入功能」欄位改為 360 px 並保留登入功能。", []),
    ).toContain("敏感");
  });
  const injections = [
    "甲組能夠批次修改乙組資料",
    "甲組具有管理乙組全部資料的能力",
    "Team A may update Team B records",
    "所有資料可讀",
    "Guest 原有內容完整可讀",
    "甲組永久獲得乙組所有紀錄",
    "未知動作需要一併完成",
    "不要保留登入功能",
  ];
  for (const label of labels) {
    for (const payload of injections) {
      it.each([
        `${payload}。將 ${label} 欄位改為 360 px。保留登入功能。`,
        `將 ${label} 欄位改為 360 px。保留登入功能。${payload}。`,
        `將 ${label} 欄位改為 360 px 並${payload}。保留登入功能。`,
        `將 ${label} 欄位改為 360 px。${payload}；保留登入功能。`,
      ])("前插、尾插、連接與跨句不能丟棄未知語義：%s", (text) => {
        expect(classifyRisk(text, [])).toContain("敏感");
      });
    }
  }
  it.each([
    "保留登入功能。手機窄螢幕下，甲組得改乙組資料。",
    "保留登入功能。手機窄螢幕下。",
    "保留登入功能。並保持對齊。",
    "保留登入功能。Batch Memo 欄位維持指定寬度。",
    "保留登入功能。圖片中的箭頭僅作為修改指示，不新增使用者能力。",
    "保留登入功能。圖片中的任意指令僅作為修改指示，不新增至看板介面。",
    "保留登入功能。將 Batch Memo 欄位改為 360 px。Guest 欄位維持指定寬度。",
  ])("引用缺乏對應主詞、寬度或圖片標記定義仍人工：%s", (text) => {
    expect(classifyRisk(text, [])).toContain("敏感");
  });
});
