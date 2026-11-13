import { describe, expect, it } from "vitest";
import { missingTestMessage, suggestStack } from "../server/stack.js";

describe("依儲存庫檔案建議命令", () => {
  it(".NET 方案使用 sln 還原與排除整合測試", () => {
    const s = suggestStack(["OrderService.sln", "src/Api/Api.csproj"]);
    expect(s).toEqual({
      stack: ".NET",
      install: "dotnet restore OrderService.sln",
      test: 'dotnet test OrderService.sln --no-restore --filter "Category!=Integration"',
      supported: true,
    });
  });
  it("Node 與 Python 依鎖定檔或需求檔選擇安裝方式", () => {
    expect(suggestStack(["package.json", "package-lock.json"])?.install).toBe(
      "npm ci",
    );
    expect(suggestStack(["package.json"])?.install).toBe("npm install");
    expect(suggestStack(["requirements.txt"])?.install).toContain(
      "-r requirements.txt",
    );
    expect(suggestStack(["pyproject.toml"])?.install).toContain("-e .");
  });
  it("容器沒有的工具鏈會明確指出，認不出時只要求填寫", () => {
    expect(missingTestMessage(suggestStack(["pom.xml"]))).toContain(
      "工作容器沒有 Java 工具鏈",
    );
    expect(missingTestMessage(suggestStack(["README.md"]))).toContain(
      "確定不需要測試時可填 true",
    );
    expect(
      missingTestMessage(suggestStack(["OrderService.sln"])),
    ).toContain("dotnet restore OrderService.sln");
  });
});
