import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PickList } from "../shared/pick-list.js";
import type { ContextEvidenceInput } from "../shared/context-evidence.js";
import type { Group, Message, Task, TriageDecision } from "../shared/types.js";
import { requireAdmin } from "./auth.js";
import type { Database, DbClient } from "./db.js";
import { notifyGroupDirect } from "./group-replies.js";
import { imageHash, saveTaskImageRefs } from "./image-context.js";
import { AppError, redact } from "./policy.js";
import { approvalNotice } from "./project-routing.js";
import { recordContextEvidence } from "./task-context.js";

export type PickItem = Pick<
  Task,
  | "id"
  | "title"
  | "summary"
  | "acceptance"
  | "missing"
  | "risk_reasons"
  | "source_ids"
  | "project_id"
  | "project_routing"
  | "target_branch"
  | "branch_selection"
  | "question"
  | "assumptions"
  | "suggestions"
> & {
  configVersion: number | null;
  images: { id: string; hash: string; origin: Message["contextOrigin"] }[];
  evidence: ContextEvidenceInput[];
  routingEvidence: ContextEvidenceInput[];
};

type StoredList = {
  id: string;
  group_id: string;
  version: number;
  items: PickItem[];
};

export function pickRoots(
  mode: Group["trigger_mode"],
  messages: Message[],
  decisions: TriageDecision[],
) {
  const joined = new Map<TriageDecision, string>();
  if (mode !== "auto") return joined;
  const roots = new Map(
    messages
      .filter((m) => !m.contextOnly && m.type === "text")
      .map((m) => [m.id, m]),
  );
  const buckets = new Map<string, Map<TriageDecision, string>>();
  for (const d of decisions) {
    if (
      !["request", "clarification"].includes(d.kind) ||
      d.taskType === "query" ||
      d.relatedTaskId ||
      d.relatedListItemId
    )
      continue;
    let root = d.sourceIds.find((id) => roots.has(id));
    // 同一段清單的分則訊息可用 LINE 回覆連回同一則根訊息。
    const visited = new Set<string>();
    while (root && !visited.has(root)) {
      visited.add(root);
      const parent = roots.get(root)?.quoted_id;
      if (!parent || !roots.has(parent) || visited.has(parent)) break;
      root = parent;
    }
    if (!root) continue;
    const items = buckets.get(root) ?? new Map<TriageDecision, string>();
    items.set(
      d,
      JSON.stringify([
        redact(d.title.trim()) || "待確認需求",
        redact(d.summary).trim(),
      ]),
    );
    buckets.set(root, items);
  }
  for (const [root, items] of buckets)
    if (new Set(items.values()).size >= 3)
      for (const decision of items.keys()) joined.set(decision, root);
  return joined;
}

const pending = "closed_at IS NULL";

export async function pickLists(db: Database): Promise<PickList[]> {
  const rows = await db.query<StoredList>(
    `SELECT id,group_id,version,items FROM pick_lists WHERE ${pending} ORDER BY created_at,id`,
  );
  return rows.map(({ id, group_id, version, items }) => ({
    id,
    groupId: group_id,
    version,
    items: items.map(({ id, title, summary }) => ({
      id,
      title,
      summary:
        summary
          .trim()
          .match(/^[^\r\n。！？]+[。！？]?/)?.[0]
          .trim() || "你可以在建立任務後補充需求。",
    })),
  }));
}

export async function pendingPickItems(
  db: Database,
  groupId: string,
  quotedIds: (string | null)[],
) {
  const rows = await db.query<{ items: PickItem[] }>(
    `SELECT l.items FROM pick_lists l WHERE group_id=$1 AND ${pending}
       ORDER BY EXISTS (
         SELECT 1 FROM jsonb_array_elements(l.items) AS e(item)
         WHERE e.item->'source_ids' ?| $2::text[]
       ) DESC,created_at DESC,id LIMIT 20`,
    [groupId, quotedIds],
  );
  return rows.flatMap(({ items }) =>
    items.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary.slice(0, 1500),
      sourceIds: item.source_ids,
      projectId: item.project_id,
      targetBranch: item.target_branch,
    })),
  );
}

export async function savePickList(
  c: DbClient,
  groupId: string,
  rootId: string,
  items: PickItem[],
) {
  const {
    rows: [list],
  } = await c.query<{ id: string }>(
    "INSERT INTO pick_lists(group_id,root_id,items) VALUES($1,$2,$3) ON CONFLICT(group_id,root_id) DO NOTHING RETURNING id",
    [groupId, rootId, JSON.stringify(items)],
  );
  if (list)
    await notifyGroupDirect(
      c,
      groupId,
      null,
      "triage",
      `pick-list:${list.id}`,
      `收到 ${items.length} 項待辦，管理者挑選後才會開始處理。`,
    );
}

export async function updatePickItem(
  c: DbClient,
  groupId: string,
  item: PickItem,
) {
  const {
    rows: [list],
  } = await c.query<StoredList>(
    `SELECT id,items FROM pick_lists WHERE group_id=$1 AND ${pending}
       AND items @> $2::jsonb FOR UPDATE`,
    [groupId, JSON.stringify([{ id: item.id }])],
  );
  if (!list) throw new AppError(409, "待挑選清單已更新，請重新辨識補充訊息");
  const prior = list.items.find((entry) => entry.id === item.id)!;
  const keepBranch =
    item.branch_selection?.basis === "default" &&
    item.project_id === prior.project_id &&
    item.configVersion === prior.configVersion &&
    item.project_routing?.bindingVersion ===
      prior.project_routing?.bindingVersion;
  const updated = {
    ...item,
    title: prior.title,
    target_branch: keepBranch ? prior.target_branch : item.target_branch,
    branch_selection: keepBranch
      ? prior.branch_selection
      : item.branch_selection,
    source_ids: [...new Set([...prior.source_ids, ...item.source_ids])],
    risk_reasons: [...new Set([...prior.risk_reasons, ...item.risk_reasons])],
    images: [
      ...new Map(
        [...prior.images, ...item.images].map((image) => [image.id, image]),
      ).values(),
    ],
    evidence: [...prior.evidence, ...item.evidence],
  };
  await c.query(
    "UPDATE pick_lists SET items=$2,version=version+1 WHERE id=$1",
    [
      list.id,
      JSON.stringify(
        list.items.map((entry) => (entry.id === item.id ? updated : entry)),
      ),
    ],
  );
}

// 撤回先鎖來源訊息，再移除受影響的項目，與建立選取的任務使用相同順序。
export async function revokePickSource(
  c: DbClient,
  groupId: string,
  sourceId: string,
) {
  await c.query(
    `WITH affected AS (
         SELECT id,items FROM pick_lists l WHERE group_id=$1 AND ${pending}
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(l.items) AS e(item) WHERE e.item->'source_ids' ? $2)
         FOR UPDATE
       )
       UPDATE pick_lists l
       SET items=kept.items,version=l.version+1,
           closed_at=CASE WHEN kept.items='[]'::jsonb THEN now() END
       FROM (
         SELECT id,coalesce(
           jsonb_agg(item ORDER BY position) FILTER (WHERE NOT (item->'source_ids' ? $2)),
           '[]'::jsonb
         ) AS items
         FROM affected CROSS JOIN LATERAL jsonb_array_elements(items) WITH ORDINALITY AS e(item,position)
         GROUP BY id
       ) kept WHERE l.id=kept.id`,
    [groupId, sourceId],
  );
}

async function createPickedTask(
  db: Database,
  c: DbClient,
  list: StoredList,
  group: Group,
  item: PickItem,
  sources: Message[],
) {
  const project = item.project_id
    ? (
        await c.query<{ config_version: number }>(
          `SELECT p.config_version FROM projects p JOIN group_projects gp ON gp.project_id=p.id
           WHERE gp.group_id=$1 AND p.id=$2 FOR SHARE OF p`,
          [group.id, item.project_id],
        )
      ).rows[0]
    : undefined;
  const current =
    item.project_routing?.bindingVersion === group.binding_version &&
    (item.project_id === null ||
      (project && project.config_version === item.configVersion));
  const images = item.images.flatMap((ref) => {
    const source = sources.find((m) => m.id === ref.id);
    return source?.image && imageHash(source.image) === ref.hash
      ? [{ ...source, contextOrigin: ref.origin }]
      : [];
  });
  const missing = [...item.missing];
  if (
    item.source_ids.some((id) => !sources.some((m) => m.id === id)) ||
    images.length !== item.images.length
  )
    missing.push("有來源訊息已無法查看，請補充或重新確認需求");
  const {
    rows: [task],
  } = await c.query<Task>(
    `INSERT INTO tasks(group_id,project_id,title,summary,acceptance,missing,risk_reasons,source_ids,
        status,dedupe_key,project_routing,target_branch,branch_selection,question,assumptions,suggestions)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_approval',$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [
      group.id,
      current ? item.project_id : null,
      item.title,
      item.summary,
      JSON.stringify(item.acceptance),
      JSON.stringify(missing),
      JSON.stringify(item.risk_reasons),
      item.source_ids,
      `pick-list:${list.id}:${item.id}`,
      JSON.stringify(
        current
          ? item.project_routing
          : {
              status: "uncertain",
              basis: "none",
              evidence: [],
              bindingVersion: group.binding_version,
              reason: "群組綁定或專案設定已更新，請重新指定專案與分支",
            },
      ),
      current ? item.target_branch : null,
      JSON.stringify(current ? item.branch_selection : null),
      JSON.stringify(item.question),
      JSON.stringify(item.assumptions),
      JSON.stringify(item.suggestions),
    ],
  );
  await c.query(
    "INSERT INTO task_versions(task_id,version,summary,acceptance) VALUES($1,$2,$3,$4)",
    [task.id, task.version, task.summary, JSON.stringify(task.acceptance)],
  );
  await saveTaskImageRefs(c, task, images);
  await recordContextEvidence(c, task.id, "triage-selected", item.evidence);
  if (current)
    await recordContextEvidence(c, task.id, "routing", item.routingEvidence);
  await db.audit(task.id, "triage", "你已從待挑選清單建立這張待確認任務", c);
  await approvalNotice(c, task, false);
}

const pickAction = z
  .object({
    version: z
      .number("請提供目前的清單版本")
      .int("清單版本必須是整數")
      .positive("清單版本必須大於零"),
    itemIds: z
      .array(z.uuid("請重新選取清單項目"), "請提供選取的清單項目")
      .max(20, "你一次最多能選取 20 個項目"),
  })
  .strict();

export function registerPickLists(app: FastifyInstance, db: Database) {
  app.post<{ Params: { id: string } }>(
    "/api/pick-lists/:id/resolve",
    async (req) => {
      const actor = await requireAdmin(db, req);
      const id = z.uuid("請重新開啟待挑選清單").parse(req.params.id);
      const { version, itemIds } = pickAction.parse(req.body);
      const chosen = new Set(itemIds);
      return db.transaction(async (c) => {
        const {
          rows: [group],
        } = await c.query<Group>(
          "SELECT g.* FROM groups g JOIN pick_lists l ON l.group_id=g.id WHERE l.id=$1 FOR UPDATE OF g",
          [id],
        );
        const {
          rows: [list],
        } = await c.query<StoredList>(
          `SELECT * FROM pick_lists WHERE id=$1 AND ${pending}`,
          [id],
        );
        if (!group || !list || list.version !== version)
          throw new AppError(409, "待挑選清單已更新或結束，請重新整理後查看");
        if (chosen.size && !group.enabled)
          throw new AppError(409, "你目前無法建立任務，請先到群組設定啟用群組");
        const items = list.items.filter((item) => chosen.has(item.id));
        if (items.length !== chosen.size)
          throw new AppError(400, "部分選取項目不在這張清單中，請重新選取");
        const sources = items.length
          ? (
              await c.query<Message>(
                `SELECT * FROM messages WHERE group_id=$1 AND id=ANY($2)
               AND NOT revoked AND received_at>message_retention_cutoff() FOR SHARE`,
                [group.id, items.flatMap((item) => item.source_ids)],
              )
            ).rows
          : [];
        const closed = await c.query(
          `UPDATE pick_lists SET items='[]',closed_at=now(),version=version+1
           WHERE id=$1 AND version=$2 AND ${pending}`,
          [id, version],
        );
        if (!closed.rowCount)
          throw new AppError(409, "待挑選清單已更新或結束，請重新整理後查看");
        for (const item of items)
          await createPickedTask(db, c, list, group, item, sources);
        await db.audit(
          null,
          "pick_list_resolved",
          items.length
            ? `${actor.login} 從待挑選清單建立了 ${items.length} 張任務`
            : `${actor.login} 選擇全部不做並結束待挑選清單`,
          c,
        );
        return { created: items.length };
      });
    },
  );
}
