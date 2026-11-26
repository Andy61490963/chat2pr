import { errors } from "@playwright/test";
import { expect, it, vi } from "vitest";
import { captureReferenceTarget, newScreens } from "../e2e/design-reference";

const missing = () =>
  Promise.reject(new errors.TimeoutError("等待虛構畫面逾時"));

it("舊版沒有定位文字時標為新增畫面，新版缺少同一文字仍失敗", async () => {
  await expect(captureReferenceTarget(true, missing)).resolves.toBe(false);
  await expect(captureReferenceTarget(false, missing)).rejects.toThrow("逾時");
  expect(newScreens(["群組.png"], ["群組.png", "新畫面.png"])).toEqual([
    "新畫面.png",
  ]);
});

it("舊版定位存在時仍須驗證可見性，導覽及瀏覽器錯誤會如實傳出", async () => {
  const present = vi.fn().mockResolvedValue(undefined);
  await expect(captureReferenceTarget(true, present)).resolves.toBe(true);
  expect(present).toHaveBeenCalledOnce();
  await expect(
    captureReferenceTarget(true, () => Promise.reject(new Error("瀏覽器關閉"))),
  ).rejects.toThrow("瀏覽器關閉");
});
