import { expect, it } from "vitest";
import { z } from "zod";
import { Decision, Decisions, instructions } from "../server/triage.js";

it("判讀提示區分同事分工、未定案討論與交給機器人的明確需求", () => {
  expect(instructions).toContain("自己承接（例如「我等下處理」），或公告給全體成員的工作，不建立任務");
  expect(instructions).toContain("kind=ignore、noTaskReason=coworker_assignment");
  expect(instructions).toContain("以問句徵詢同事意見（例如「先朝這版改？」），不建立任務");
  expect(instructions).toContain("kind=defer、noTaskReason=undecided_discussion");
  expect(instructions).toContain("仍未定案，用 kind=ignore 並保留原因");
  expect(instructions).toContain("/任務、提到機器人、回覆機器人訊息");
  expect(instructions).toContain("沒有指定由誰處理的明確需求，照常建立");
});

it("結構化輸出要求填寫未建立任務的原因欄位，並限制可用值", () => {
  const reason = Decision.shape.noTaskReason;
  expect(reason.parse("coworker_assignment")).toBe("coworker_assignment");
  expect(reason.parse("undecided_discussion")).toBe("undecided_discussion");
  expect(reason.parse(null)).toBeNull();
  expect(reason.safeParse("任意群組原文").success).toBe(false);
  const schema = z.toJSONSchema(Decisions);
  expect(schema).toMatchObject({
    properties: {
      decisions: {
        items: {
          required: expect.arrayContaining(["noTaskReason"]),
        },
      },
    },
  });
});
