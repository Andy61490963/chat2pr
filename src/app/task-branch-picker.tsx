import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/form-controls";
import { readApiResponse } from "./api-response";
import type { Act, Detail } from "./shared";
import {
  validTargetBranch,
  type BranchCatalog,
} from "../../shared/task-branch";

export function TaskBranchPicker({
  detail,
  busy,
  act,
}: {
  detail: Detail;
  busy: boolean;
  act: Act;
}) {
  const task = detail.task;
  const [catalog, setCatalog] = useState<
    | (BranchCatalog & {
        version: number;
        projectId: string;
        configuredBranch: string;
      })
    | null
  >(null);
  const [name, setName] = useState(task.target_branch ?? "");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setError("");
    void fetch(`/api/tasks/${task.id}/branches`, { signal: controller.signal })
      .then((r) => readApiResponse<NonNullable<typeof catalog>>(r))
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.version !== task.version || data.projectId !== task.project_id)
          throw new Error("任務目標已變更，請重新開啟任務");
        setCatalog(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "無法取得分支，請稍後重試");
      });
    return () => controller.abort();
  }, [task.id, task.version, task.project_id, reload]);
  return (
    <div className="mt-3 space-y-3 rounded-md border bg-background p-3">
      <p className="font-medium">選擇這筆任務的目標分支</p>
      {error ? (
        <div role="alert">
          <p className="break-words text-danger">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReload((v) => v + 1)}
          >
            重新取得分支
          </Button>
        </div>
      ) : !catalog ? (
        <p role="status">正在從 GitHub 取得分支…</p>
      ) : (
        <>
          <p className="break-all text-xs text-muted-foreground">
            專案預設：{catalog.configuredBranch} · GitHub 預設：
            {catalog.defaultBranch}
          </p>
          <Label htmlFor="task-branch-options">GitHub 分支</Label>
          <select
            id="task-branch-options"
            className="h-10 w-full min-w-0 rounded-md border bg-background px-2 text-sm"
            value={catalog.names.includes(name) ? name : ""}
            onChange={(e) => setName(e.target.value)}
          >
            <option value="">請選擇分支</option>
            {catalog.names.map((n) => (
              <option key={n} value={n}>
                {n}
                {n === catalog.defaultBranch ? "（GitHub 預設）" : ""}
              </option>
            ))}
          </select>
          <Label htmlFor="task-branch-name">目標分支名稱</Label>
          <Input
            id="task-branch-name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 develop 或 release/2026"
          />
          {catalog.truncated && (
            <p className="text-xs">
              分支較多，清單只顯示前 500 筆；可以輸入完整名稱。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            只調整這筆任務。儲存後舊核准失效，請重新確認需求、儲存庫與分支。
          </p>
          <Button
            disabled={busy || !validTargetBranch(name)}
            onClick={() =>
              void act(
                task,
                "target",
                {
                  project_id: task.project_id,
                  target_branch: name,
                  config_version: detail.projectReview?.config_version,
                  binding_version: detail.projectReview?.binding_version,
                },
                "已更換分支，請重新確認",
              )
            }
          >
            儲存目標分支
          </Button>
        </>
      )}
    </div>
  );
}
