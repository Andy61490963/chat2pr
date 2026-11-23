import { describe, expect, it } from "vitest";
import {
  describeTestFailures,
  parseTestFailures,
  phaseEndEvents,
} from "../server/test-failures.js";
import { ObservationBuffer } from "../server/observation.js";

// 樣本都是虛構的專案與測試名稱，格式照各工具的實際輸出。
const xunit = [
  "  Determining projects to restore...",
  "[xUnit.net 00:00:01.20]     Demo.Shop.Tests.CartTests.Total_ShouldSum(withCoupon: True) [FAIL]",
  "[xUnit.net 00:00:01.20]       Assert.Equal() Failure: Values differ",
  "[xUnit.net 00:00:01.20]       Expected: 3",
  "[xUnit.net 00:00:01.20]       Actual:   2",
  "[xUnit.net 00:00:01.20]       Stack Trace:",
  "[xUnit.net 00:00:01.20]         /workspace/tests/CartTests.cs(12,0): at Demo.Shop.Tests.CartTests.Total_ShouldSum()",
  "[xUnit.net 00:00:01.30]     Demo.Shop.Tests.CartTests.Skipped_One [SKIP]",
  "  Failed Demo.Shop.Tests.CartTests.Total_ShouldSum(withCoupon: True) [3 ms]",
  "  Error Message:",
  "   Assert.Equal() Failure: Values differ",
  "  Stack Trace:",
  "     at Demo.Shop.Tests.CartTests.Total_ShouldSum() in /workspace/tests/CartTests.cs:line 12",
  "  Failed Demo.Shop.Tests.OrderTests.Submit_ShouldSave [8 ms]",
  "  Error Message:",
  "   System.InvalidOperationException : 找不到虛構訂單 A-001",
  "  Stack Trace:",
  "     at Demo.Shop.Orders.Submit()",
  "",
  "Failed!  - Failed:     2, Passed:    40, Skipped:     1, Total:    43, Duration: 2 s - Demo.Shop.Tests.dll (net8.0)",
].join("\n");

const vitest = [
  " ❯ tests/cart.test.ts (2 tests | 1 failed) 12ms",
  "   × 購物車 > 加入商品後總價正確 5ms",
  "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯",
  "",
  " FAIL  tests/cart.test.ts > 購物車 > 加入商品後總價正確",
  "AssertionError: expected 2 to be 3 // Object.is equality",
  "",
  "- Expected",
  "+ Received",
  " ❯ tests/cart.test.ts:8:21",
  " FAIL  tests/broken.test.ts [ tests/broken.test.ts ]",
  "Error: Cannot find module '../src/missing'",
  " ❯ tests/broken.test.ts:1:1",
  " Test Files  2 failed (2)",
].join("\n");

const jest = [
  " FAIL  tests/cart.test.js",
  "  ● 購物車 › 加入商品後總價正確",
  "",
  "    expect(received).toBe(expected) // Object.is equality",
  "",
  "    Expected: 3",
  "    Received: 2",
  "",
  "      6 |   expect(total).toBe(3);",
  "      at Object.<anonymous> (tests/cart.test.js:6:17)",
  "",
  "  ● Console",
  "    console.log 虛構的除錯訊息",
  "Tests:       1 failed, 3 passed, 4 total",
].join("\n");

const pytest = [
  "=================================== FAILURES ===================================",
  "_________________________________ test_total __________________________________",
  "E       assert 2 == 3",
  "=========================== short test summary info ============================",
  "FAILED tests/test_cart.py::test_total - assert 2 == 3",
  "FAILED tests/test_cart.py::test_coupon[half] - ValueError: 虛構折扣碼無效",
  "ERROR tests/test_orders.py::test_submit - fixture 'db' not found",
  "========================= 2 failed, 1 error, 5 passed in 0.12s =================",
].join("\n");

describe("parseTestFailures 擷取失敗的測試", () => {
  it(".NET xUnit／dotnet test：同一個測試的兩種格式合併成一筆，訊息取第一段", () => {
    expect(parseTestFailures(xunit)).toEqual({
      tests: [
        {
          name: "Demo.Shop.Tests.CartTests.Total_ShouldSum(withCoupon: True)",
          message:
            "Assert.Equal() Failure: Values differ Expected: 3 Actual:   2",
        },
        {
          name: "Demo.Shop.Tests.OrderTests.Submit_ShouldSave",
          message: "System.InvalidOperationException : 找不到虛構訂單 A-001",
        },
      ],
      more: 0,
    });
  });

  it("只有 [FAIL] 行、錯誤訊息被截掉時仍列出名稱", () => {
    const output =
      "[xUnit.net 00:00:13.98]     Demo.Shop.Tests.StockTests.Reserve_ShouldLock [FAIL]\n    at command (file:///workspace/scripts/test.mjs:31:34)";
    expect(parseTestFailures(output)).toEqual({
      tests: [
        { name: "Demo.Shop.Tests.StockTests.Reserve_ShouldLock", message: "" },
      ],
      more: 0,
    });
  });

  it("Vitest：每個失敗測試與整個檔案失敗都列出", () => {
    expect(parseTestFailures(vitest)?.tests).toEqual([
      {
        name: "tests/cart.test.ts > 購物車 > 加入商品後總價正確",
        message: "AssertionError: expected 2 to be 3 // Object.is equality",
      },
      {
        name: "tests/broken.test.ts [ tests/broken.test.ts ]",
        message: "Error: Cannot find module '../src/missing'",
      },
    ]);
  });

  it("Jest：取 ● 標題與第一段訊息，不把 Console 與檔案行當成測試", () => {
    expect(parseTestFailures(jest)?.tests).toEqual([
      {
        name: "購物車 › 加入商品後總價正確",
        message: "expect(received).toBe(expected) // Object.is equality",
      },
    ]);
  });

  it("pytest：取簡短摘要的 FAILED／ERROR 行", () => {
    expect(parseTestFailures(pytest)?.tests).toEqual([
      { name: "tests/test_cart.py::test_total", message: "assert 2 == 3" },
      {
        name: "tests/test_cart.py::test_coupon[half]",
        message: "ValueError: 虛構折扣碼無效",
      },
      {
        name: "tests/test_orders.py::test_submit",
        message: "fixture 'db' not found",
      },
    ]);
  });

  it("沒有失敗或認不出格式時回傳 null", () => {
    expect(
      parseTestFailures(
        "Passed!  - Failed:     0, Passed:    43, Skipped:     0, Total:    43",
      ),
    ).toBeNull();
    expect(parseTestFailures(" ✓ tests/cart.test.ts (2 tests) 5ms")).toBeNull();
    expect(
      parseTestFailures("error CS1002: ; expected\nBuild FAILED."),
    ).toBeNull();
    expect(parseTestFailures("")).toBeNull();
  });

  it("超過 10 個只列前 10 個，其餘寫另有幾個", () => {
    const output = Array.from(
      { length: 13 },
      (_, i) => `FAILED tests/test_many.py::test_case_${i + 1} - assert False`,
    ).join("\n");
    const parsed = parseTestFailures(output)!;
    expect(parsed.tests).toHaveLength(10);
    expect(parsed.tests[9].name).toBe("tests/test_many.py::test_case_10");
    expect(parsed.more).toBe(3);
    const text = describeTestFailures(parsed);
    expect(text.split("\n")[0]).toBe("失敗的測試（共 13 個）：");
    expect(text).toContain("1. tests/test_many.py::test_case_1：assert False");
    expect(text).not.toContain("test_case_11");
    expect(text.split("\n").at(-1)).toBe(
      "另有 3 個失敗的測試，完整清單見執行紀錄。",
    );
  });

  it("錯誤訊息裡的機密會遮蔽，名稱與訊息都有長度上限", () => {
    const secret = "ghp_" + "A".repeat(36);
    const output = [
      `  ● 連線 › 使用權杖 ${secret}`,
      "",
      `    Error: 驗證失敗 password=fake-password-123 Bearer fake-bearer-456 ${secret}`,
      "",
      `FAILED tests/test_long.py::test_${"x".repeat(400)} - ${"y".repeat(800)}`,
    ].join("\n");
    const parsed = parseTestFailures(output)!;
    const text = describeTestFailures(parsed);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("fake-password-123");
    expect(text).not.toContain("fake-bearer-456");
    expect(parsed.tests[1].name.length).toBeLessThanOrEqual(200);
    expect(parsed.tests[1].message.length).toBeLessThanOrEqual(300);
  });
});

describe("測試階段失敗時保留失敗測試的錯誤區塊（執行紀錄）", () => {
  const secret = "ghp_" + "B".repeat(36);
  const failing = [
    "[xUnit.net 00:00:01.20]     Demo.Shop.Tests.CartTests.Total_ShouldSum [FAIL]",
    "[xUnit.net 00:00:01.20]       Assert.Equal() Failure: 虛構總價應為 300",
    "[xUnit.net 00:00:01.20]       Stack Trace:",
    "[xUnit.net 00:00:01.20]         /workspace/tests/CartTests.cs(12,0): at Demo.Shop.Tests.CartTests.Total_ShouldSum()",
    `[xUnit.net 00:00:01.21]       連線字串 password=fake-db-password token ${secret}`,
    "[xUnit.net 00:00:01.30]     Demo.Shop.Tests.CartTests.Other [SKIP]",
  ].join("\n");
  // 失敗訊息在前，後面是大量通過的日誌：只留結尾時斷言訊息會被擠掉。
  const noise = Array.from(
    { length: 800 },
    (_, i) => `  Passed Demo.Shop.Tests.Bulk.Case_${i} [1 ms]`,
  ).join("\n");
  const result = {
    exitCode: 1,
    stdout: `${failing}\n${noise}\nFailed!  - Failed:     1, Passed:   800`,
    stderr: "Node.js v24.0.0",
  };

  it("失敗時另存一筆錯誤區塊，結尾照舊保存在階段結束", () => {
    const events = phaseEndEvents("test", result);
    expect(events.map((e) => e.kind)).toEqual(["message", "phase_end"]);
    expect(events[0].detail).toContain(
      "Assert.Equal() Failure: 虛構總價應為 300",
    );
    expect(events[0].detail).toContain("CartTests.cs(12,0)");
    expect(events[0].detail).not.toContain("Case_1 ");
    expect(events[1].detail).not.toContain("虛構總價應為 300");
    expect(events[1].detail).toContain("Failed!  - Failed:     1");
  });

  it("經過執行器的事件緩衝後遮蔽機密，單筆在長度上限內", () => {
    const buffer = new ObservationBuffer();
    for (const event of phaseEndEvents("test", result))
      buffer.add("00000000-0000-4000-8000-000000000001", "test", event);
    const saved = buffer.read("00000000-0000-4000-8000-000000000001");
    expect(saved).toHaveLength(2);
    const text = saved.map((e) => e.detail).join("\n");
    expect(text).toContain("虛構總價應為 300");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("fake-db-password");
    for (const e of saved) expect(e.detail!.length).toBeLessThanOrEqual(6000);
  });

  it("很多失敗測試時總長有上限，並註明有幾段沒保存", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) =>
        `FAILED tests/test_many.py::test_case_${i} - AssertionError: ${"虛構".repeat(150)}`,
    ).join("\n");
    const [message] = phaseEndEvents("test", {
      exitCode: 1,
      stdout: many,
      stderr: "",
    });
    expect(message.kind).toBe("message");
    expect(message.detail!.length).toBeLessThanOrEqual(5100);
    expect(message.detail).toMatch(/另有 \d+ 段錯誤區塊沒有保存/);
  });

  it("測試通過、其他階段或認不出格式時只有原本的階段結束", () => {
    expect(
      phaseEndEvents("test", { ...result, exitCode: 0 }).map((e) => e.kind),
    ).toEqual(["phase_end"]);
    expect(phaseEndEvents("install", result).map((e) => e.kind)).toEqual([
      "phase_end",
    ]);
    expect(
      phaseEndEvents("test", {
        exitCode: 1,
        stdout: "error CS1002: ; expected",
        stderr: "",
      }).map((e) => e.kind),
    ).toEqual(["phase_end"]);
  });
});
