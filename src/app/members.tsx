import { DataList, InlineNotice } from "@/components/ui/layout";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  memberRoleLabels,
  memberRoleText,
} from "../../shared/status-glossary.js";
import { SessionExpiredError } from "./api-response";
import { type Request, type Run, date, Initials, message } from "./shared";
import { ConfirmButton, ConfirmDialogContent } from "./confirm";

type Role = keyof typeof memberRoleLabels;
type Member = {
  github_id: string;
  login: string;
  role: Role;
  added_by: string | null;
  created_at: string;
  owner?: boolean;
};

function MemberRoleSelect({
  member,
  busy,
  onSave,
}: {
  member: Member;
  busy: boolean;
  onSave: (role: Role) => Promise<boolean>;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [change, setChange] = useState<{ from: Role; to: Role } | null>(null);
  // 選了新角色時確認視窗會立刻打開；選單收合若把焦點還給下拉選單，對話框會以為點到外面而自動關閉。
  const confirming = useRef(false);

  return (
    <Dialog
      open={change !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setChange(null);
      }}
    >
      <Select
        value={member.role}
        disabled={busy}
        onValueChange={(value) => {
          if (
            (value === "member" || value === "admin") &&
            value !== member.role
          ) {
            confirming.current = true;
            const from = member.role;
            // 用 Enter 選取時，同一次按鍵的預設動作會落在剛打開的對話框按鈕上（「取消」）而立刻關掉；
            // 等這次按鍵處理完再打開。
            window.setTimeout(() => setChange({ from, to: value }), 0);
          }
        }}
      >
        <SelectTrigger
          ref={trigger}
          className="w-28 max-sm:min-h-11"
          aria-label={`${member.login} 的角色`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          onCloseAutoFocus={(event) => {
            // 剛選了新角色：焦點交給確認視窗，不還給下拉選單。
            if (confirming.current) {
              confirming.current = false;
              event.preventDefault();
            }
          }}
        >
          <SelectItem value="member" className="max-sm:min-h-11">
            {memberRoleLabels.member}
          </SelectItem>
          <SelectItem value="admin" className="max-sm:min-h-11">
            {memberRoleLabels.admin}
          </SelectItem>
        </SelectContent>
      </Select>
      {change && (
        <ConfirmDialogContent
          title="變更成員角色"
          description={
            <span className="grid gap-3 text-left">
              <span className="grid gap-1">
                <span>GitHub 帳號</span>
                <strong className="wrap-anywhere text-foreground">
                  {member.login}
                </strong>
              </span>
              <span className="grid grid-cols-2 gap-3">
                <span className="grid gap-1">
                  原角色
                  <strong className="text-foreground">
                    {memberRoleLabels[change.from]}
                  </strong>
                </span>
                <span className="grid gap-1">
                  新角色
                  <strong className="text-foreground">
                    {memberRoleLabels[change.to]}
                  </strong>
                </span>
              </span>
              <span className="border-t pt-3 text-foreground">
                {change.to === "admin"
                  ? `將取得${memberRoleText.adminPermissions}的權限。`
                  : `將失去${memberRoleText.adminPermissions}的權限。`}
              </span>
            </span>
          }
          dismiss="取消"
          confirm={busy ? memberRoleText.saving : "確認變更"}
          confirmVariant="default"
          dialogActionClassName="max-sm:min-h-11"
          footerClassName="max-sm:flex-col"
          pending={busy}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus({ preventScroll: true });
          }}
          onConfirm={async () => {
            if (busy) return;
            await onSave(change.to);
            setChange(null);
          }}
        />
      )}
    </Dialog>
  );
}

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
  const changeRole = (member: Member, nextRole: Role) =>
    run(
      async () => {
        const unconfirmed =
          "無法確認角色是否已變更。服務未提供可確認的結果，請重新整理成員名單，確認目前角色後再試。";
        let updated: Member;
        try {
          updated = await request<Member>(
            `/api/members/${member.github_id}`,
            "PUT",
            { role: nextRole },
          );
        } catch (error) {
          if (error instanceof SessionExpiredError) throw error;
          throw new Error(unconfirmed);
        }
        if (
          updated?.github_id !== member.github_id ||
          (updated.role !== "admin" && updated.role !== "member")
        )
          throw new Error(unconfirmed);
        setMembers(
          (current) =>
            current?.map((entry) =>
              entry.github_id === updated.github_id ? updated : entry,
            ) ?? null,
        );
        return updated;
      },
      (updated) =>
        `${updated.login} 目前的角色為${memberRoleLabels[updated.role]}。`,
    );
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>加入成員</CardTitle>
          <CardDescription>
            輸入同事的 GitHub 帳號。對方之後用 GitHub
            登入看板即可，不需要另外設定密碼。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-2 sm:grid-cols-form-action"
            onSubmit={(e) => {
              e.preventDefault();
              void act(
                () => request("/api/members", "POST", { login, role }),
                `已加入 ${login}`,
              ).then((ok) => {
                // 加入失敗時保留帳號，改一個字就能再送。
                if (ok) setLogin("");
              });
            }}
          >
            <Input
              aria-label="GitHub 帳號"
              placeholder="GitHub 帳號，例如 demo-xiaolin"
              className="max-sm:min-h-11"
              value={login}
              onChange={(e) => setLogin(e.target.value.trim())}
              required
            />
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger
                className="w-full max-sm:min-h-11"
                aria-label="角色"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member" className="max-sm:min-h-11">
                  {memberRoleLabels.member}
                </SelectItem>
                <SelectItem value="admin" className="max-sm:min-h-11">
                  {memberRoleLabels.admin}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button className="max-sm:min-h-11" disabled={busy || !login}>
              <UserPlus /> 加入
            </Button>
          </form>
          <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-md border px-3 py-2.5">
              <dt className="font-medium">{memberRoleLabels.member}</dt>
              <dd className="text-muted-foreground">
                查看收件匣、任務與聊天室，可以核准、結束任務、採用方案、修改這一題與重試任務。
              </dd>
            </div>
            <div className="rounded-md border px-3 py-2.5">
              <dt className="font-medium">{memberRoleLabels.admin}</dt>
              <dd className="text-muted-foreground">
                另外可以{memberRoleText.adminPermissions}。
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
          <InlineNotice as="p" tone="danger" className="m-4">
            {error}
          </InlineNotice>
        )}
        <DataList>
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
                    ? memberRoleText.owner
                    : `由 ${m.added_by ?? memberRoleLabels.admin} 於 ${date(m.created_at)} 加入`}
                </span>
              </span>
              {m.owner ? (
                <Badge variant="good">{memberRoleLabels.admin}</Badge>
              ) : (
                <>
                  <MemberRoleSelect
                    member={m}
                    busy={busy}
                    onSave={(nextRole) => changeRole(m, nextRole)}
                  />
                  <ConfirmButton
                    variant="ghost"
                    size="icon-sm"
                    className="max-sm:size-11"
                    dialogActionClassName="max-sm:min-h-11"
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
        </DataList>
      </Card>
    </div>
  );
}
