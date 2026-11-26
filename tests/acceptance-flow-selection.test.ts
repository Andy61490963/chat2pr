import { expect, it } from "vitest";
import { selectFlowCases } from "../scripts/acceptance/flows/catalog.js";

it("預設收錄全部二十個情境，指定編號只執行該案", () => {
  expect(selectFlowCases([]).cases.map(item => item.number)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  expect(selectFlowCases(["02"]).cases.map(item => item.number)).toEqual([2]);
});

it("真實模型只跑查詢且不允許故障注入與未知編號", () => {
  expect(selectFlowCases(["--real"]).cases.map(item => item.number)).toEqual([1]);
  for (const selection of [["--real", "2"], ["--real", "--fault=model"], ["0"], ["21"], ["1", "2"], ["--unknown"], ["--fault=pr", "1"]]) {
    expect(() => selectFlowCases(selection)).toThrow();
  }
});
