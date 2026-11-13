import { useCallback, useEffect, useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type Request, type Run, date, Initials, message } from "./shared";
import { ConfirmButton } from "./confirm";

type Role = "admin" | "member";
type Member = {
  github_id: string;
  login: string;
  role: Role;
  added_by: string | null;
  created_at: string;
  owner?: boolean;
};
const roleLabel: Record<Role, string> = { admin: "管理者", member: "成員" };

export function MembersView({
  request,
  run,
  busy,
  me,
}: {
  request: Request;
  run: Run;
  busy: boolean;
  me: string;
}) {
  const [members, setMembers] = useState<Member[] | null>(null),
    [error, setError] = useState(""),
    [login, setLogin] = useState(""),
    [role, setRole] = useState<Role>("member");
  const load = useCallback(async () => {
    try {
      setMembers(await request<Member[]>("/api/members"));
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, [request]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = (fn: () => Promise<unknown>, done: string) =>
    run(async () => {
      await fn();
      await load();
    }, done);
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>加入成員</CardTitle>
          <CardDescription>
            輸入同事的 GitHub 帳號。對方之後用 GitHub 登入看板即可，不需要另外設定密碼。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () => request("/api/members", "POST", { login, role }),
                `已加入 ${login}`,
              ).then(() => setLogin(""));
            }}
          >
            <Input
              aria-label="GitHub 帳號"
              placeholder="GitHub 帳號，例如 octocat"
              value={login}
              onChange={(e) => setLogin(e.target.value.trim())}
              required
            />
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger className="w-full" aria-label="角色">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">成員</SelectItem>
                <SelectItem value="admin">管理者</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={busy || !login}>
              <UserPlus /> 加入
            </Button>
          </form>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-lg border px-3 py-2.5">
              <dt className="font-medium">成員</dt>
              <dd className="text-muted-foreground">
                查看收件匣、任務與聊天室，可以核准、拒絕、採用方案、補充需求與重試任務。
              </dd>
            </div>
            <div className="rounded-lg border px-3 py-2.5">
              <dt className="font-medium">管理者</dt>
              <dd className="text-muted-foreground">
                另外可以管理群組、專案、設定、系統與成員名單。
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle>成員名單</CardTitle>
        </CardHeader>
        {error && (
          <p className="m-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <ul className="divide-y">
          {(members ?? []).map((m) => (
            <li key={m.github_id} className="flex items-center gap-3 px-5 py-3">
              <Initials name={m.login} className="size-8 text-xs" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 truncate font-medium">
                  {m.login}
                  {m.login === me && (
                    <span className="text-xs font-normal text-muted-foreground">
                      （你）
                    </span>
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {m.owner
                    ? "擁有者，固定為管理者"
                    : `由 ${m.added_by ?? "管理者"} 於 ${date(m.created_at)} 加入`}
                </span>
              </span>
              {m.owner ? (
                <Badge variant="good">管理者</Badge>
              ) : (
                <>
                  <Select
                    value={m.role}
                    onValueChange={(v) =>
                      void act(
                        () =>
                          request(`/api/members/${m.github_id}`, "PUT", {
                            role: v,
                          }),
                        `已將 ${m.login} 改為${roleLabel[v as Role]}`,
                      )
                    }
                  >
                    <SelectTrigger
                      className="w-28"
                      aria-label={`${m.login} 的角色`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">成員</SelectItem>
                      <SelectItem value="admin">管理者</SelectItem>
                    </SelectContent>
                  </Select>
                  <ConfirmButton
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除 ${m.login}`}
                    disabled={busy}
                    title={`移除 ${m.login}？`}
                    description="對方會立即被登出，之後也無法再登入看板；要恢復需重新加入。"
                    confirm="移除成員"
                    onConfirm={() =>
                      act(
                        () => request(`/api/members/${m.github_id}`, "DELETE"),
                        `已移除 ${m.login}`,
                      )
                    }
                  >
                    <Trash2 />
                  </ConfirmButton>
                </>
              )}
            </li>
          ))}
          {members && members.length === 1 && (
            <li className="px-5 py-4 text-sm text-muted-foreground">
              目前只有你。在上方加入同事的 GitHub 帳號。
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}
