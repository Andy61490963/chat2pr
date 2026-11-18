import { describe, expect, it } from "vitest";
import {
  sqlFailure,
  type SqlError,
  type SqlFailureContext,
} from "../server/database-capture.js";
import { AppError } from "../server/policy.js";

/**
 * 不需資料庫：以假的 tedious 錯誤物件驗證 sqlFailure 的白話對照。
 * 帳密、主機都是虛構值；錯誤訊息故意夾帶它們，確認不會被帶到畫面上。
 */
const fakeUser = "fictional_reader";
const fakePassword = "Fict1onal-Pa55word";
const fakeHost = "db.fictional-plant.test";

function tedious(
  message: string,
  extra: { code?: string; number?: number } = {},
): SqlError {
  return Object.assign(new Error(message), extra);
}

const check = (connected = true): SqlFailureContext => ({
  viaTunnel: false,
  purpose: "check",
  connected,
});
const capture = (connected = true): SqlFailureContext => ({
  viaTunnel: false,
  purpose: "capture",
  connected,
});

function messageOf(error: SqlError, ctx: SqlFailureContext) {
  const e = sqlFailure(error, ctx);
  expect(e).toBeInstanceOf(AppError);
  expect(e.statusCode).toBe(422);
  // 不論哪個分支，都不帶連線帳密、主機或原始英文長訊息。
  expect(e.message).not.toContain(fakePassword);
  expect(e.message).not.toContain(fakeUser);
  expect(e.message).not.toContain(fakeHost);
  expect(e.message).not.toMatch(/Server=|Password=|User Id=/i);
  return e.message;
}

describe("定期檢查（連線完成後）的查詢錯誤", () => {
  it.each([
    [207, "Invalid column name 'stale_minutes'.", "stale_minutes"],
    [208, "Invalid object name 'dbo.EQM_STATUS'.", "dbo.EQM_STATUS"],
    [208, "無效的物件名稱 'dbo.機台狀態'。", "dbo.機台狀態"],
  ])("%s：欄位或資料表不存在，附上物件名稱", (number, raw, name) => {
    const text = messageOf(
      tedious(
        `${raw} Server=${fakeHost};User Id=${fakeUser};Password=${fakePassword}`,
        { code: "EREQUEST", number },
      ),
      check(),
    );
    expect(text).toBe(`查詢的欄位或資料表不存在：${name}，請修正檢查 SQL。`);
  });
  it("物件名稱過長時截到 100 字", () => {
    const long = "x".repeat(300);
    const text = messageOf(
      tedious(`Invalid object name '${long}'.`, {
        code: "EREQUEST",
        number: 208,
      }),
      check(),
    );
    expect(text).toContain(`：${"x".repeat(100)}，`);
    expect(text).not.toContain("x".repeat(101));
  });
  it("訊息沒有引號時仍說明欄位或資料表不存在", () => {
    expect(
      messageOf(
        tedious("Invalid object name.", { code: "EREQUEST", number: 208 }),
        check(),
      ),
    ).toBe("查詢的欄位或資料表不存在，請修正檢查 SQL。");
  });
  it.each([102, 156, 170])("%s：語法錯誤", (number) =>
    expect(
      messageOf(
        tedious("Incorrect syntax near 'FORM'.", { code: "EREQUEST", number }),
        check(),
      ),
    ).toBe("檢查 SQL 語法錯誤，請修正後試跑。"),
  );
  it.each([229, 297, 300])(
    "%s：沒有 SELECT 權限（不是擷取的 VIEW DEFINITION）",
    (number) =>
      expect(
        messageOf(
          tedious(
            `The SELECT permission was denied on the object 'EQM', user '${fakeUser}'.`,
            { code: "EREQUEST", number },
          ),
          check(),
        ),
      ).toBe("帳號沒有查詢這張資料表的 SELECT 權限。"),
  );
  it("1222：鎖定逾時", () =>
    expect(
      messageOf(
        tedious("Lock request time out period exceeded.", {
          code: "EREQUEST",
          number: 1222,
        }),
        check(),
      ),
    ).toBe("資料表被其他交易鎖住超過 5 秒，請避開長交易時段或縮小查詢範圍。"));
  it("查詢階段的 ETIMEOUT：查詢太慢，不是連不上主機", () => {
    const text = messageOf(
      tedious("Timeout: Request failed to complete in 60000ms", {
        code: "ETIMEOUT",
      }),
      check(),
    );
    expect(text).toBe("查詢超過 60 秒仍未完成，請加條件或索引。");
    expect(text).not.toContain("連不上");
  });
  it("其他 EREQUEST：說是檢查查詢被拒並附錯誤代碼，不再叫人確認帳號權限", () => {
    const text = messageOf(
      tedious(`Arithmetic overflow error. Password=${fakePassword}`, {
        code: "EREQUEST",
        number: 8115,
      }),
      check(),
    );
    expect(text).toBe("資料庫拒絕了檢查查詢（錯誤 8115），請試跑確認 SQL。");
    expect(text).not.toContain("讀取結構");
  });
  it("已經是 AppError（例如逾時停止）原樣回傳", () => {
    const own = new AppError(422, "檢查超過時間限制，已停止。");
    expect(sqlFailure(own, check())).toBe(own);
  });
});

describe("連線階段（connected=false）沿用連線說明，擷取與檢查相同", () => {
  it.each([check(false), capture(false)])("%o", (ctx) => {
    expect(
      messageOf(
        tedious(`Login failed for user '${fakeUser}'.`, {
          code: "ELOGIN",
          number: 18456,
        }),
        ctx,
      ),
    ).toBe("資料庫拒絕登入，請檢查帳號、密碼與資料庫名稱。");
    expect(
      messageOf(
        tedious(`Failed to connect to ${fakeHost}:1433 in 15000ms`, {
          code: "ETIMEOUT",
        }),
        ctx,
      ),
    ).toBe("連不上資料庫主機，請檢查主機、連接埠、防火牆，或改用 SSH 跳板。");
    expect(
      messageOf(
        tedious(`Failed to connect to ${fakeHost}:1433 in 15000ms`, {
          code: "ETIMEOUT",
        }),
        { ...ctx, viaTunnel: true },
      ),
    ).toBe("SSH 跳板連得上，但從跳板連不到資料庫主機與連接埠。");
    expect(
      messageOf(
        tedious('Cannot open database "FictionalMes" requested by the login.', {
          code: "ELOGIN",
          number: 4060,
        }),
        ctx,
      ),
    ).toBe("資料庫不存在，或這個帳號沒有開啟它的權限。");
    expect(
      messageOf(
        tedious(
          "Failed to establish TLS/SSL connection: certificate verify failed",
        ),
        ctx,
      ),
    ).toContain("加密連線");
  });
});

describe("擷取結構（capture）", () => {
  it("連線完成後的 ETIMEOUT 說查詢逾時，不再說連不上主機", () => {
    const text = messageOf(
      tedious("Timeout: Request failed to complete in 60000ms", {
        code: "ETIMEOUT",
      }),
      capture(),
    );
    expect(text).toContain("讀取結構的查詢超過時間限制");
    expect(text).not.toContain("連不上");
  });
  it("其他錯誤維持原本的擷取說明", () => {
    expect(
      messageOf(
        tedious("VIEW DEFINITION permission denied", {
          code: "EREQUEST",
          number: 300,
        }),
        capture(),
      ),
    ).toContain("VIEW DEFINITION");
    expect(
      messageOf(
        tedious("Invalid object name 'sys.fictional'.", {
          code: "EREQUEST",
          number: 208,
        }),
        capture(),
      ),
    ).toBe("資料庫拒絕了讀取結構的查詢，請確認帳號權限。");
  });
});
