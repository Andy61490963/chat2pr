import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, fixture, reset } from "./helpers.js";
import { Triage } from "../server/triage.js";
import { Budget } from "../server/budget.js";
import { GitHub } from "../server/github.js";
import { Line } from "../server/line.js";
import type {
  Group,
  Message,
  Project,
  TriageDecision,
} from "../shared/types.js";

beforeEach(reset);
afterAll(() => db.close());

const base: TriageDecision = {
  kind: "request",
  projectId: null,
  title: "調寬 Part Spec 欄位",
  summary: "將 Part Spec 欄位改為 360 px，保留既有登入功能。",
  acceptance: ["Part Spec 欄位寬度為 360 px。", "登入功能維持原有行為。"],
  sourceIds: ["risk-source"],
  risks: [],
  missing: [],
  relatedTaskId: null,
  suggestions: [],
};
async function apply(
  overrides: Partial<TriageDecision> = {},
  source = "把 Part Spec 改為 360 px，保留原有登入功能。",
) {
  await fixture();
  const group = await db.one<Group>("SELECT * FROM groups WHERE id='group-a'");
  const project = await db.one<Project>("SELECT * FROM projects");
  await db.query(
    "INSERT INTO messages(id,group_id,type,text) VALUES('risk-source','group-a','text',$1)",
    [source],
  );
  const messages = await db.query<Message>("SELECT * FROM messages");
  const triage = new Triage(
    db,
    { classify: async () => [] },
    new GitHub(),
    new Line(db),
    new Budget(db),
  );
  await triage.apply(
    group,
    [project],
    messages,
    [{ ...base, ...overrides }],
    "00000000-0000-4000-8000-000000000041",
  );
  return db.one<{
    status: string;
    risk_reasons: string[];
    approved_version: number | null;
  }>("SELECT status,risk_reasons,approved_version FROM tasks");
}

describe("需求各層皆通過確定性風險關卡", () => {
  // 53a8 固定真六次維持 1/6；只重播五筆完整原決定，不重新呼叫模型。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位實際寬度皆為 360 px，且上下對齊。",
        "手機窄螢幕下仍維持目標欄寬，並可透過水平捲動查看其他欄位。",
        "其他欄位、原有資料及既有登入功能維持正常。",
      ],
    },
    {
      case: "B04-image-first 第 3 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的實際欄寬均為 360 px，且上下對齊。",
        "其他欄位與既有資料保持不變，登入功能正常。",
        "手機窄螢幕下仍可水平捲動表格，Part Spec 欄位不因螢幕縮小而被壓縮。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列欄位對齊，實際欄寬為 360 px。",
        "圖片中的三筆 Part Spec 文字完整可讀，其他欄位與資料維持原樣。",
        "手機版保留表格橫向捲動，Part Spec 欄位不因螢幕變窄而縮減至 360 px 以下。",
        "既有登入功能可正常使用。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批圖片，將青鳥看板的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度均為 360 px，且上下對齊。",
        "圖片所示三筆 Part Spec 文字可完整閱讀。",
        "其他欄位、資料及登入功能維持原有行為。",
        "手機畫面可水平捲動表格，查看所有欄位。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度均為 360 px，且上下對齊。",
        "其他欄位、既有資料與登入功能維持原有行為。",
        "手機窄螢幕下保留表格水平捲動，Part Spec 欄位不因可視寬度不足而縮窄。",
      ],
    },
  ])(
    "53a8 真模型完整輸出重播：$case",
    async ({ title, summary, acceptance }) => {
      expect(await apply({ title, summary, acceptance })).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );

  // ed529 固定真六次維持 1/6；只重播五筆完整原決定，不重新呼叫模型。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一的青鳥看板圖片，將 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 欄位實際顯示寬度為 360 px，欄頭與各資料列對齊。",
        "Part Spec 文字完整可讀，其他欄位、資料及既有登入功能維持正常。",
        "手機畫面保留表格水平捲動，可捲動查看所有欄位。",
      ],
    },
    {
      case: "B04-image-first 第 2 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片的紅框標註，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 欄位實際呈現寬度為 360 px，表頭與各資料列對齊。",
        "其他欄位及既有資料保持不變，不將圖片中的測試資料替換進系統。",
        "既有登入功能維持正常。",
        "手機上保留表格橫向捲動，可捲動查看所有欄位，Part Spec 欄位不被壓縮至小於 360 px。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一的青鳥看板圖片，將紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列欄位寬度均為 360 px，且上下對齊。",
        "其他欄位的內容與既有功能維持正常，登入功能不受影響。",
        "手機窄螢幕下保留表格水平捲動，可捲動查看全部欄位，Part Spec 欄位不被壓縮。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度均為 360 px，且上下對齊。",
        "其他欄位、既有資料及登入功能維持原有行為。",
        "手機窄螢幕下仍可水平捲動表格，完整查看所有欄位及 Part Spec 內容。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 欄位的實際顯示寬度為 360 px，表頭與各資料列對齊。",
        "圖片所示的三筆 Part Spec 內容完整可讀，其他欄位及既有資料維持不變。",
        "手機檢視時保留表格橫向捲動，能捲動查看所有欄位。",
        "既有登入功能仍可正常使用。",
      ],
    },
  ])(
    "ed529 真模型完整輸出重播：$case",
    async ({ title, summary, acceptance }) => {
      expect(await apply({ title, summary, acceptance })).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );

  // 6100 固定真六次維持 2/6；只重播四筆完整原決定，不重新呼叫模型。
  it.each([
    {
      case: "B04-image-first 第 3 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批圖片，將青鳥看板的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機既有捲動操作。",
      acceptance: [
        "Part Spec 欄位的實際顯示寬度為 360 CSS px，表頭與各資料列對齊。",
        "圖片中的三筆 Part Spec 範例文字完整可讀，無截斷或遮擋。",
        "其他欄位、資料內容及登入功能維持原有行為。",
        "手機版仍可透過既有捲動操作查看完整表格。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度均為 360 CSS px，且上下對齊。",
        "圖片所示的中文及中英混合規格內容完整可讀。",
        "其他欄位及原有資料保持不變，登入功能正常。",
        "手機瀏覽時保留原有表格捲動功能，能捲動查看所有欄位。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "調整青鳥看板 Part Spec 欄寬為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板表格的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度皆為 360 px，且上下對齊。",
        "其他欄位的寬度、資料內容及既有登入功能維持正常。",
        "手機畫面保留表格水平捲動，Part Spec 欄位不因窄螢幕縮小，所有欄位皆可捲動查看。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度均為 360 px，且上下對齊。",
        "其他欄位的設定、資料內容及既有登入功能維持原狀。",
        "手機窄螢幕下保留表格水平捲動，可捲動查看全部欄位，Part Spec 欄不因畫面縮窄而壓縮。",
      ],
    },
  ])(
    "6100 真模型完整輸出重播：$case",
    async ({ title, summary, acceptance }) => {
      expect(await apply({ title, summary, acceptance })).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );

  // 981d 固定真六次維持 1/6；只重播五筆完整原決定，不重新呼叫模型。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、既有資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 欄位實際呈現寬度為 360 px，表頭與各資料列對齊。",
        "其他欄位的設定與既有資料維持不變。",
        "手機版維持原有捲動功能，可捲動查看完整表格內容。",
        "既有登入功能維持正常。",
      ],
    },
    {
      case: "B04-image-first 第 3 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批圖片，將青鳥看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 欄位寬度為 360 px，表頭與各資料列對齊。",
        "Part Spec 文字完整可讀，不因欄寬調整而被裁切。",
        "其他欄位及既有資料保持不變，登入功能正常。",
        "手機版維持既有捲動功能，可捲動查看表格內容。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框所示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄寬均為 360 px。",
        "其他欄位、既有資料與登入功能維持原有行為。",
        "手機窄螢幕下仍可水平捲動表格並查看所有欄位，Part Spec 欄寬維持 360 px。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機橫向捲動。",
      acceptance: [
        "Part Spec 欄位呈現寬度為 360 CSS px，表頭與各資料列對齊。",
        "其他欄位及既有資料保持不變，Part Spec 內容可完整閱讀。",
        "手機窄螢幕仍可橫向捲動查看全部欄位，Part Spec 欄位不因螢幕變窄而縮小。",
        "既有登入功能可正常使用。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列欄位對齊，實際欄寬為 360 px。",
        "Part Spec 原有文字及其他欄位、資料均保留。",
        "手機窄螢幕下仍可水平捲動查看完整表格，Part Spec 欄位維持 360 px。",
        "既有登入功能維持正常。",
      ],
    },
  ])(
    "981d 真模型完整輸出重播：$case",
    async ({ title, summary, acceptance }) => {
      expect(await apply({ title, summary, acceptance })).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );

  // 固定重播 75f2e35 六筆原始模型輸出；原六次 0/6 結果不變。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度一致為 360 px。",
        "Part Spec 的中英文規格內容完整可讀。",
        "其他欄位、資料及登入功能維持既有行為。",
        "手機檢視時保留表格水平捲動，能捲動查看所有欄位。",
      ],
    },
    {
      case: "B04-image-first 第 2 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 欄位的表頭與各資料列寬度均為 360 CSS px，並保持對齊。",
        "手機窄螢幕下，Part Spec 欄位維持指定寬度，表格可水平捲動以查看所有欄位。",
        "其他欄位、既有資料及登入功能維持正常。",
      ],
    },
    {
      case: "B04-image-first 第 3 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 欄位寬度為 360 px，表頭與所有資料列對齊。",
        "其他欄位及現有資料保持不變，登入功能正常。",
        "手機瀏覽時保留橫向捲動，Part Spec 欄位不因螢幕變窄而縮小。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "調整青鳥看板紅框所指的 Part Spec 欄位寬度為 360 px，保留其他欄位、資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 欄位標題與各資料列對齊，實際顯示欄寬為 360 px。",
        "其他欄位的寬度、內容及既有資料維持不變，Part Spec 文字完整可讀。",
        "手機窄螢幕下保留表格橫向捲動，可捲動查看全部欄位，Part Spec 欄位不被壓縮。",
        "既有登入功能可正常使用。",
        "圖片中的紅框、箭頭及寬度標註僅作為修改指示，不新增至看板介面。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、既有資料、登入功能及手機橫向捲動。",
      acceptance: [
        "Part Spec 欄位實際顯示寬度為 360 CSS px，表頭與各列儲存格對齊。",
        "Part Spec 及其他欄位的既有資料內容不變，其他欄位與既有登入功能維持正常。",
        "手機窄螢幕下保留表格橫向捲動，Part Spec 欄位不因螢幕縮窄而壓縮。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度均為 360 CSS px，且上下對齊。",
        "其他欄位寬度、現有資料及登入功能維持原有行為。",
        "手機窄螢幕下 Part Spec 欄位維持 360 CSS px，表格可水平捲動以查看所有欄位。",
      ],
    },
  ])("重播75f2完整語義呈現：$case", async ({ title, summary, acceptance }) => {
    const task = await apply(
      { title, summary, acceptance },
      "請依本批唯一一張青鳥看板圖片，將紅框 Part Spec 欄位改成圖中標註的目標寬度，保留其他資料及手機捲動。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  // 固定重播 9f5f7c87 真高推論的五筆誤判；原六次 1/6 證據保留。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機橫向捲動。",
      acceptance: [
        "Part Spec 欄位的表頭與各資料列對齊，實際欄寬為 360 CSS px。",
        "其他欄位、既有資料及登入功能維持原有行為。",
        "手機窄螢幕下表格可橫向捲動，Part Spec 欄寬仍維持 360 px，所有欄位皆可捲動查看。",
      ],
    },
    {
      case: "B04-image-first 第 2 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片的紅框標註，將青鳥看板 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各列儲存格寬度一致，實際欄寬為 360 px。",
        "其他欄位及既有資料完整保留，登入功能維持原有行為。",
        "手機窄螢幕下 Part Spec 欄寬維持 360 px，表格可水平捲動並查看所有欄位。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度均為 360 px，且上下對齊。",
        "其他欄位與原有資料保持不變，登入功能正常。",
        "手機版保留原有捲動功能，可橫向捲動查看完整表格。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 欄位寬度為 360 CSS px，表頭與各資料列對齊。",
        "Part Spec 原有內容完整可讀，其他欄位與資料維持原樣。",
        "手機版保留表格橫向捲動，可捲動查看所有欄位。",
        "既有登入功能維持正常。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批青鳥看板圖片，將紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列欄位對齊，欄寬為 360 px。",
        "Part Spec 中文及中英混合內容完整可讀，未遭截斷。",
        "其他欄位、資料及既有登入功能維持正常。",
        "手機瀏覽時保留表格水平捲動，可捲動查看全部欄位。",
      ],
    },
  ])("重播9f5完整呈現句型：$case", async ({ title, summary, acceptance }) => {
    const task = await apply(
      { title, summary, acceptance },
      "請依本批唯一一張青鳥看板圖片，將紅框 Part Spec 欄位改成圖中標註的目標寬度，保留其他資料及手機捲動。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  it("不同專案欄位沿用同段明確定義後仍須確認專案", async () => {
    const task = await apply(
      {
        title: "調寬 Batch Memo 欄位",
        summary: "將 Batch Memo 欄位改為 360 px，保留登入功能。",
        acceptance: ["Batch Memo 內容完整可讀。", "手機保留水平捲動。"],
      },
      "依唯一截圖紅框調整 Batch Memo 欄寬，保留其他資料。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  it("重播925683ad唯一誤判：資料內容維持正常仍須確認專案", async () => {
    // 原真模型固定六次仍保留 5/6，不把文字重播視為真模型重測。
    const task = await apply(
      {
        title: "青鳥看板 Part Spec 欄寬調整為 360 px",
        summary:
          "依本批唯一的青鳥看板圖片，將 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
        acceptance: [
          "Part Spec 表頭與各資料列欄位對齊，欄寬為 360 CSS px。",
          "Part Spec 文字完整可讀；其他欄位、資料內容及既有登入功能維持正常。",
          "手機窄螢幕仍可橫向捲動表格，查看所有欄位。",
        ],
      },
      "請依本批唯一一張青鳥看板圖片，將紅框 Part Spec 欄位改成圖中標註的目標寬度，保留其他資料及手機捲動。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  // 固定重播 3a47 輪的三筆誤判，不改該輪真實 3/6 結果。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批圖片將 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度一致，均為 360 px。",
        "其他欄位及資料維持原樣，Part Spec 內容完整可讀。",
        "手機畫面仍可水平捲動瀏覽表格，Part Spec 欄位不因窄螢幕而縮小。",
        "既有登入功能正常運作。",
      ],
    },
    {
      case: "B04-image-first 第 2 次",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一的青鳥看板圖片，將紅框 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度均為 360 CSS px，且上下對齊。",
        "Part Spec 文字完整可讀，其他欄位與既有資料維持不變。",
        "手機窄螢幕下保留表格水平捲動，可捲動查看所有欄位。",
        "既有登入功能可正常使用。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 表頭與所有資料列的欄位寬度均為 360 px，且上下對齊。",
        "其他欄位的寬度、顯示資料及登入功能維持原有行為。",
        "手機窄螢幕仍可水平捲動表格以查看所有欄位，Part Spec 欄位維持 360 px。",
      ],
    },
  ])("重播3a47純畫面誤判：$case", async ({ title, summary, acceptance }) => {
    const task = await apply(
      { title, summary, acceptance },
      "請依本批唯一一張青鳥看板圖片，將紅框 Part Spec 欄位改成圖中標註的目標寬度，保留其他資料及手機捲動。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  it("重播保守語境修復後首例：現有資料不變仍須確認專案", async () => {
    // 原真模型六次結果仍為 5 通過、1 失敗；此處只重播風險關卡。
    const task = await apply(
      {
        title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
        summary:
          "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
        acceptance: [
          "Part Spec 表頭與各資料列儲存格的實際欄寬均為 360 px。",
          "其他欄位、現有資料及登入功能維持原有行為。",
          "手機窄螢幕下仍可捲動表格，查看所有欄位與資料。",
        ],
      },
      "請依本批唯一一張青鳥看板圖片，將紅框 Part Spec 欄位改成圖中標註的目標寬度，保留其他資料及手機捲動。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  // 固定重播第一次修正後六次真模型輸出；原結果 2 通過、4 失敗仍保留。
  // 只驗證風險關卡，沒有重新呼叫模型或驗證圖片。
  it.each([
    {
      case: "B04-image-first 第 1 次",
      priorStatus: "失敗",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度均為 360 px。",
        "其他欄位及既有資料維持不變。",
        "手機瀏覽時保留表格水平捲動，可查看所有欄位與完整資料。",
        "既有登入功能維持正常。",
      ],
    },
    {
      case: "B04-image-first 第 2 次",
      priorStatus: "通過",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機橫向捲動。",
      acceptance: [
        "Part Spec 欄位寬度為 360 px，表頭與各資料列對齊。",
        "圖片中的三筆 Part Spec 規格文字完整可讀。",
        "其他欄位與資料內容保持不變，既有登入功能正常。",
        "手機窄螢幕下保留表格橫向捲動，Part Spec 欄位仍維持 360 px。",
      ],
    },
    {
      case: "B04-image-first 第 3 次",
      priorStatus: "失敗",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能與手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度均為 360 CSS px。",
        "其他欄位的寬度、內容與既有資料維持原樣。",
        "手機瀏覽時保留表格水平捲動，可捲動查看全部欄位。",
        "既有登入功能維持可用。",
      ],
    },
    {
      case: "B04-text-first 第 1 次",
      priorStatus: "通過",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "調整青鳥看板的 Part Spec 欄位寬度為圖片標註的 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度為 360 px，且上下對齊。",
        "其他欄位與既有資料保持不變，既有登入功能正常。",
        "手機窄螢幕下保留表格水平捲動，可捲動查看全部欄位，Part Spec 欄位仍維持 360 px。",
      ],
    },
    {
      case: "B04-text-first 第 2 次",
      priorStatus: "失敗",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 表頭與所有資料列的實際欄寬均為 360 px，且上下對齊。",
        "手機窄螢幕下 Part Spec 欄位維持 360 px，表格可水平捲動查看其他欄位。",
        "其他欄位、既有資料及登入功能維持原有行為。",
      ],
    },
    {
      case: "B04-text-first 第 3 次",
      priorStatus: "失敗",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批圖片將測試看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 欄位寬度為 360 CSS px，表頭與各資料列對齊。",
        "Part Spec 規格文字完整可讀，不因欄寬調整而截斷。",
        "其他欄位及既有資料保持不變，登入功能正常。",
        "手機檢視時保留表格水平捲動，可捲動查看所有欄位。",
      ],
    },
  ])(
    "重播固定六次模型輸出：$case（原本 $priorStatus）",
    async ({ title, summary, acceptance }) => {
      const task = await apply(
        { title, summary, acceptance },
        "請依本批唯一一張青鳥看板圖片，將紅框 Part Spec 欄位改成圖中標註的目標寬度，保留其他資料及手機捲動。",
      );
      expect(task).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );

  it.each([
    ["未知能力副詞", {}, "保留登入功能。甲組能夠批次修改乙組資料。"],
    ["未知能力時效", {}, "保留登入功能。甲組可以永久修改乙組資料。"],
    ["未知授予用語", {}, "保留登入功能。甲組具有管理乙組全部資料的能力。"],
    ["英文跨組能力", {}, "保留登入功能。Team A may update Team B records."],
    ["題目", { title: "取消密碼驗證" }, undefined],
    ["摘要", { summary: "保留既有登入功能，但移除 session 檢查" }, undefined],
    [
      "驗收",
      { acceptance: ["Part Spec 為 360 px。", "取消角色檢查。"] },
      undefined,
    ],
    ["來源原文", {}, "加寬 Part Spec，保留登入功能，但取消權限驗證。"],
    [
      "驗收中的能力授予",
      {
        acceptance: [
          "Part Spec 為 360 px。",
          "保留登入功能，甲組可以修改乙組的資料。",
        ],
      },
      undefined,
    ],
    ["來源中的能力授予", {}, "保留登入功能，丙組取得全部控制能力。"],
    ["來源中的跨行否定", {}, "切勿\n保留登入功能"],
  ] as const)(
    "敏感變更只出現在%s仍不能自動排程",
    async (_label, override, source) => {
      const task = await apply(override as Partial<TriageDecision>, source);
      expect(task.status).toBe("awaiting_approval");
      expect(task.approved_version).toBeNull();
      expect(task.risk_reasons.join("；")).toContain("敏感");
    },
  );
  it("保留原文風險，即使模型改寫安全並回傳空 risks", async () => {
    const task = await apply({ risks: [] }, "關閉登入身分驗證，其他保持不變。");
    expect(task.status).toBe("awaiting_approval");
    expect(task.risk_reasons.join("；")).toContain("敏感");
  });
  it("只調整外觀而完整保留登入行為仍須確認專案", async () => {
    const task = await apply();
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });
  it.each([
    {
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片的紅框標註，將測試看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 欄位的表頭與各資料列對齊，實際顯示寬度為 360 px。",
        "其他欄位及所有既有資料維持不變，既有登入功能正常。",
        "手機窄螢幕下保留表格水平捲動，可捲動查看全部欄位，Part Spec 欄位維持 360 px。",
      ],
    },
    {
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機橫向捲動。",
      acceptance: [
        "Part Spec 欄位的表頭與各資料列對齊，實際欄寬為 360 CSS px。",
        "其他欄位與既有資料保持不變，登入功能維持原有行為。",
        "手機畫面保留表格橫向捲動，Part Spec 欄位不因螢幕較窄而被壓縮。",
      ],
    },
  ])("重播首輪 B04 模型文字可通過風險關卡：$title", async (decision) => {
    // 只重播已固定的決定文字，沒有假稱重新驗證模型或圖片傳遞。
    const task = await apply(
      decision,
      "按唯一截圖紅框調整 Part Spec 欄寬，其餘功能與資料保持不變。",
    );
    expect(task).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });

  it.each([
    {
      title: "調整青鳥看板 Part Spec 欄寬為 360 px",
      summary:
        "將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及所有資料列的欄寬均為 360 px，且上下對齊。",
        "其他欄位、既有資料及登入功能維持正常。",
        "手機窄螢幕下可水平捲動表格，查看所有欄位及完整內容。",
      ],
    },
    {
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、既有登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度均為 360 px，且上下對齊。",
        "其他欄位、資料內容及既有登入功能維持原行為。",
        "手機窄螢幕下保留表格水平捲動，Part Spec 欄位不因畫面變窄而縮小。",
      ],
    },
    {
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列的欄位寬度皆為 360 px，且上下對齊。",
        "其他欄位、資料內容及既有登入功能維持原有行為。",
        "手機螢幕下仍可水平捲動表格，瀏覽全部欄位及資料。",
      ],
    },
  ])("6ab 真模型誤判文字重播：$title", async (decision) => {
    expect(await apply(decision)).toEqual({
      status: "awaiting_approval",
      approved_version: null,
      risk_reasons: [],
    });
  });
  // 8bb 固定六次仍為 2/6；此處只重播四筆原始決定，不宣稱真模型重新驗證。
  it.each([
    {
      case: "B04-image-first-2",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "將測試看板的 Part Spec 欄位寬度調整為圖片標註的 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭與各資料列欄寬一致，實際寬度為 360 CSS px。",
        "其他欄位、既有資料及登入功能維持正常。",
        "手機瀏覽時 Part Spec 欄位仍維持 360 px，表格可正常水平捲動並查看所有欄位。",
      ],
    },
    {
      case: "B04-image-first-3",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度設為 360 px，保留其他欄位、資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 欄位的實際寬度為 360 px，表頭與各資料列對齊。",
        "Part Spec 中文及英文內容完整可讀，不因欄寬調整遭截斷。",
        "其他欄位、既有資料及登入功能維持原有行為。",
        "手機窄螢幕下仍可橫向捲動表格，查看所有欄位；Part Spec 欄寬維持 360 px。",
      ],
    },
    {
      case: "B04-text-first-1",
      title: "調整青鳥看板 Part Spec 欄寬為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度皆為 360 CSS px，且上下對齊。",
        "其他欄位及所有資料內容維持原樣，既有登入功能正常。",
        "手機窄螢幕下仍可水平捲動表格，查看所有欄位，Part Spec 欄位維持 360 CSS px。",
      ],
    },
    {
      case: "B04-text-first-2",
      title: "將青鳥看板 Part Spec 欄寬設為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板紅框標示的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、登入功能及手機橫向捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度一致為 360 CSS px。",
        "Part Spec 中文及中英文混合內容完整可讀，不因欄寬調整而截斷。",
        "其他欄位、既有資料及登入功能維持正常。",
        "手機畫面可橫向捲動查看完整表格，Part Spec 欄位不被壓縮。",
      ],
    },
  ])(
    "8bb 真模型純呈現語彙重播：$case",
    async ({ title, summary, acceptance }) => {
      expect(await apply({ title, summary, acceptance })).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );
  // bc3d 新代理真六次仍保留3/6；這裡只重播三筆完整原決定。
  it.each([
    {
      case: "B04-image-first-2",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板表格的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、資料、既有登入功能及手機水平捲動。",
      acceptance: [
        "Part Spec 表頭及所有資料列的欄寬均為 360 px，且上下對齊。",
        "其他欄位、資料內容及既有登入功能維持原有行為。",
        "手機窄螢幕下 Part Spec 欄仍維持 360 px，並可水平捲動查看完整表格。",
      ],
    },
    {
      case: "B04-image-first-3",
      title: "青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "將青鳥 MES 看板的 Part Spec 欄位寬度調整為 360 px，保留其他欄位、既有資料、登入功能及手機捲動。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度皆為 360 CSS px，且上下對齊。",
        "其他欄位與既有資料保持不變，登入功能正常。",
        "手機瀏覽時保留表格橫向捲動，可捲動查看所有欄位，Part Spec 欄不因螢幕較窄而縮小。",
      ],
    },
    {
      case: "B04-text-first-1",
      title: "將青鳥看板 Part Spec 欄寬調整為 360 px",
      summary:
        "依本批唯一圖片，將青鳥看板 Part Spec 欄位寬度調整為 360 px，保留其他欄位、所有資料、登入功能及手機捲動行為。",
      acceptance: [
        "Part Spec 表頭及各資料列的欄位寬度一致，實際呈現為 360 px。",
        "其他欄位與既有資料保持不變，Part Spec 文字不因截斷而無法完整閱讀。",
        "手機窄螢幕下保留表格橫向捲動，Part Spec 欄位維持 360 px。",
        "既有登入功能可正常使用。",
      ],
    },
  ])(
    "bc3d真輸出呈現組合重播：$case",
    async ({ title, summary, acceptance }) => {
      expect(await apply({ title, summary, acceptance })).toEqual({
        status: "awaiting_approval",
        approved_version: null,
        risk_reasons: [],
      });
    },
  );
});
