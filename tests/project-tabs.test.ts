import { expect, it } from "vitest";
import { projectFromUrl } from "../shared/project-tabs.js";

it.each(["overview", "environment", "access", "memory"])(
  "從專案連結讀出指定分頁 %s",
  (tab) => {
    expect(
      projectFromUrl(
        new URL(
          `https://demo.invalid/projects/?project=demo&tab=${tab}&source=demo`,
        ),
      ),
    ).toEqual({ id: "demo", tab });
  },
);

it("預設使用概況，只有專案頁且帶有專案識別碼才開啟詳情", () => {
  for (const suffix of ["", "&tab=unknown", "&tab=constructor"]) {
    expect(
      projectFromUrl(
        new URL(`https://demo.invalid/projects?project=demo${suffix}`),
      ),
    ).toEqual({ id: "demo", tab: "overview" });
  }

  for (const path of [
    "/projects?tab=memory",
    "/groups?project=demo&tab=memory",
  ]) {
    expect(projectFromUrl(new URL(path, "https://demo.invalid"))).toBeNull();
  }
});
