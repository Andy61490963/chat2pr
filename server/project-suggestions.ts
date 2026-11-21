import type { DbClient } from "./db.js";
import { mentions, projectAliases } from "./project-routing.js";
import type { UnboundProjectSuggestion } from "../shared/project-routing.js";
import type { Message, Project } from "../shared/types.js";

type Candidate = Pick<
  Project,
  "id" | "name" | "repo" | "description" | "config_version"
> & {
  bound: boolean;
};
type IndexMatch = { project_id: string; source_id: string };
const segmenter = new Intl.Segmenter("zh-TW", { granularity: "word" });
const termsOf = (text: string) =>
  [
    ...new Set(
      [...segmenter.segment(text.toLowerCase())]
        .filter(({ segment }) =>
          /^(?:[a-z][a-z0-9_]{3,63}|\p{Script=Han}{2,16})$/u.test(segment),
        )
        .map(({ segment }) => segment),
    ),
  ].slice(0, 32);
const searchTerms = (messages: Pick<Message, "id" | "text">[]) =>
  messages.map(({ id, text }) => ({ id, terms: termsOf(text ?? "") }));

export function rankProjectSuggestions(
  messages: Pick<Message, "id" | "text">[],
  candidates: Candidate[],
  knownProjects: Pick<Project, "id" | "name" | "repo">[],
  indexMatches: IndexMatch[] = [],
  search = searchTerms(messages),
): UnboundProjectSuggestion[] {
  const matches = candidates.flatMap((project) => {
    const aliases = projectAliases(project, knownProjects);
    const mentionsProject = messages.filter(({ text }) =>
      aliases.some((alias) => alias && mentions(text ?? "", alias)),
    );
    if (mentionsProject.length)
      return [
        {
          project,
          score: 3,
          reason: "你的訊息提到了這個專案的名稱或儲存庫。",
          sourceIds: mentionsProject.map(({ id }) => id),
        },
      ];
    const description = search.filter(
      ({ terms }) =>
        terms.filter((term) => mentions(project.description, term)).length >= 2,
    );
    if (description.length)
      return [
        {
          project,
          score: 2,
          reason: "你的訊息用詞與這個專案的說明相符。",
          sourceIds: description.map(({ id }) => id),
        },
      ];
    const index = indexMatches.filter((hit) => hit.project_id === project.id);
    return index.length
      ? [
          {
            project,
            score: 1,
            reason: "你的訊息用詞與這個專案的程式內容相符。",
            sourceIds: index.map((hit) => hit.source_id),
          },
        ]
      : [];
  });
  const boundScore = Math.max(
    0,
    ...matches.filter(({ project }) => project.bound).map(({ score }) => score),
  );
  return matches
    .filter(({ project, score }) => !project.bound && score > boundScore)
    .sort(
      (a, b) => b.score - a.score || a.project.id.localeCompare(b.project.id),
    )
    .slice(0, 2)
    .map(({ project, reason, sourceIds }) => ({
      projectId: project.id,
      configVersion: project.config_version,
      reason,
      sourceIds: sourceIds.slice(0, 3),
    }));
}

export async function suggestUnboundProjects(
  c: DbClient,
  groupId: string,
  messages: Message[],
  sourceIds: string[],
  knownProjects: Pick<Project, "id" | "name" | "repo">[],
) {
  const sources = messages.filter(
    (m) => !m.contextOnly && m.text && sourceIds.includes(m.id),
  );
  if (!sources.length) return [];
  const candidates = (
    await c.query<Candidate>(
      `SELECT p.id,p.name,p.repo,p.description,p.config_version,gp.project_id IS NOT NULL AS bound
     FROM projects p LEFT JOIN group_projects gp ON gp.project_id=p.id AND gp.group_id=$1
     WHERE p.enabled AND p.validated_at IS NOT NULL AND p.repo_missing_at IS NULL`,
      [groupId],
    )
  ).rows;
  if (!candidates.some((project) => !project.bound)) return [];
  const search = searchTerms(sources).filter(({ terms }) => terms.length >= 2);
  // 同一段索引至少命中兩個不同的詞，才以該則訊息作為依據。
  const matches = search.length
    ? (
        await c.query<IndexMatch>(
          `SELECT r.project_id,m.id AS source_id
         FROM repo_indexes r
         CROSS JOIN jsonb_to_recordset($2::jsonb) m(id text,terms text[])
         WHERE r.project_id=ANY($1) AND r.active_sha=r.wanted_sha AND EXISTS(
           SELECT 1 FROM embeddings e
           WHERE e.kind='repo' AND e.project_id=r.project_id AND e.sha=r.active_sha
             AND EXISTS(
               SELECT 1 FROM unnest(m.terms) AS terms(term)
               WHERE lower(concat(e.path,' ',e.content)) ~
                 CASE WHEN term ~ '^[a-z]' THEN '(^|[^a-z0-9_])'||term||'([^a-z0-9_]|$)' ELSE term END
               OFFSET 1
             )
         )
         ORDER BY r.project_id,m.id`,
          [candidates.map(({ id }) => id), JSON.stringify(search)],
        )
      ).rows
    : [];
  // 索引只回傳命中的訊息位置，未綁定專案的程式內容不送進判讀或通知。
  return rankProjectSuggestions(
    sources,
    candidates,
    knownProjects,
    matches,
    search,
  );
}
