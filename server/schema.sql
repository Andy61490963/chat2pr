CREATE TABLE IF NOT EXISTS settings (id integer PRIMARY KEY CHECK(id=1), value jsonb NOT NULL);
INSERT INTO settings VALUES(1,'{"paused":true,"daily_budget":15,"task_budget":3,"task_minutes":30,"triage_model":"gpt-5.4-mini","coding_model":"gpt-6.1-sol","retention_days":30,"admin_line_id":null}') ON CONFLICT DO NOTHING;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS revision uuid NOT NULL DEFAULT gen_random_uuid();
CREATE OR REPLACE FUNCTION revise_settings() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.revision:=gen_random_uuid();
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER settings_value_revision BEFORE UPDATE OF value ON settings
 FOR EACH ROW WHEN (NEW.value IS DISTINCT FROM OLD.value) EXECUTE FUNCTION revise_settings();
CREATE TABLE IF NOT EXISTS projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, repo text NOT NULL UNIQUE,
 base_branch text NOT NULL DEFAULT 'main', image text NOT NULL DEFAULT 'line-agentflow-worker:local',
 install_command text NOT NULL DEFAULT 'npm ci', test_command text NOT NULL DEFAULT 'npm test',
 sensitive_paths text[] NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT false,
 validated_at timestamptz, validation_error text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS index_paths text[] NOT NULL DEFAULT '{}';
-- 舊專案保留人工設定；新建專案由管理 API 明確選用自動模式。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_mode text NOT NULL DEFAULT 'manual' CHECK(setup_mode IN ('auto','manual'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_plan jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_status text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS context_updated_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS context_updated_by text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS setup_input jsonb;
-- 收集差異時對預設建置產物排除清單的增減（「名稱/」加入、「!名稱/」移除）；空陣列即沿用預設。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS collect_excludes text[] NOT NULL DEFAULT '{}';
CREATE OR REPLACE FUNCTION valid_repo_index_paths(paths text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT cardinality(paths)<=50 AND COALESCE(bool_and(
   value IS NOT NULL AND length(value) BETWEEN 1 AND 1024 AND value=btrim(value)
   AND value !~ '[[:cntrl:]\\:*?\[\]{}]' AND value !~ '[@+!]\('
   AND value !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
 ),true) FROM unnest(paths) value
$$;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_index_paths_check;
ALTER TABLE projects ADD CONSTRAINT projects_index_paths_check CHECK(valid_repo_index_paths(index_paths));
CREATE TABLE IF NOT EXISTS groups (
 id text PRIMARY KEY, name text NOT NULL, project_id uuid REFERENCES projects(id), enabled boolean NOT NULL DEFAULT false,
 first_pending_at timestamptz, last_pending_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (id text PRIMARY KEY, provider text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS messages (
 id text PRIMARY KEY, group_id text NOT NULL REFERENCES groups(id), user_id text, type text NOT NULL, text text,
 image bytea, image_mime text, quoted_id text, received_at timestamptz NOT NULL DEFAULT now(), revoked boolean NOT NULL DEFAULT false,
 processed boolean NOT NULL DEFAULT false, batch_id uuid
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(group_id,received_at) WHERE processed=false;
-- 第一次升級改用明確指令，舊訊息只供檢視，不追溯派工；重跑遷移不改管理者選擇。
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='groups' AND column_name='trigger_mode') THEN
  ALTER TABLE groups ADD COLUMN trigger_mode text NOT NULL DEFAULT 'command' CHECK(trigger_mode IN ('auto','command'));
  UPDATE messages SET processed=true WHERE NOT processed;
  UPDATE groups SET first_pending_at=NULL,last_pending_at=NULL;
 END IF;
END $$;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS trigger_version integer NOT NULL DEFAULT 1;
-- 獨立於收訊時間，避免新訊息或五分鐘彙整上限跳過判讀失敗退避。
ALTER TABLE groups ADD COLUMN IF NOT EXISTS triage_retry_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS trigger_mode text NOT NULL DEFAULT 'auto' CHECK(trigger_mode IN ('auto','command','chat'));
-- 保存收訊當下驗證過的引用，避免通知清理後改變等待時間；舊訊息維持一般等待。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS bot_reply boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS messages_chat_timeline ON messages(group_id,received_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id), group_id text NOT NULL REFERENCES groups(id),
 title text NOT NULL, summary text NOT NULL, acceptance jsonb NOT NULL DEFAULT '[]', risk_reasons jsonb NOT NULL DEFAULT '[]', missing jsonb NOT NULL DEFAULT '[]',
 source_ids text[] NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'awaiting_approval', version integer NOT NULL DEFAULT 1,
 approved_version integer, base_sha text, branch text, issue_number integer, issue_url text, pr_number integer, pr_url text,
 parent_id uuid REFERENCES tasks(id), last_error text, dedupe_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_versions (task_id uuid REFERENCES tasks(id), version integer NOT NULL, summary text NOT NULL, acceptance jsonb NOT NULL, approved_by text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(task_id,version));
-- 舊需求沒有結構化問題與假設；新假設同時寫入摘要，沿用既有需求版本保存歷史。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS question jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assumptions jsonb NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS audit (id bigserial PRIMARY KEY, task_id uuid REFERENCES tasks(id), kind text NOT NULL, detail text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (id_hash text PRIMARY KEY, user_id text NOT NULL, csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (id_hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_codes (code_hash text PRIMARY KEY, expires_at timestamptz NOT NULL, consumed_at timestamptz);
CREATE TABLE IF NOT EXISTS reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid REFERENCES tasks(id), day text NOT NULL, amount numeric(12,6) NOT NULL,
 spent numeric(12,6) NOT NULL DEFAULT 0, released boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES tasks(id), version integer NOT NULL,
 reservation_id uuid REFERENCES reservations(id), status text NOT NULL DEFAULT 'starting', token_hash text, model text NOT NULL,
 deadline timestamptz NOT NULL, heartbeat_at timestamptz NOT NULL DEFAULT now(), proxy_active boolean NOT NULL DEFAULT false,
 started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, workspace text, result jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active ON runs((true)) WHERE completed_at IS NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS observed boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS run_events(
 id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 source text NOT NULL, seq integer NOT NULL, at timestamptz NOT NULL, phase text NOT NULL,
 kind text NOT NULL, detail text, thread_id text, container_id text, exit_code integer,
 UNIQUE(run_id,source,seq)
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id,id);
CREATE TABLE IF NOT EXISTS usage (
 id bigserial PRIMARY KEY, reservation_id uuid REFERENCES reservations(id), model text NOT NULL, input_tokens bigint NOT NULL,
 cached_tokens bigint NOT NULL, output_tokens bigint NOT NULL, cost numeric(12,6) NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid REFERENCES tasks(id), kind text NOT NULL, dedupe_key text NOT NULL UNIQUE,
 text text NOT NULL, sent_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_health (name text PRIMARY KEY, ok boolean NOT NULL, detail text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE projects ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS triage_failures integer NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS triage_error text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_paths text[] NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS approved_paths text[] NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now()+interval '35 minutes';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS issue_version integer;
-- 一個群組可綁定多個專案；需求由 AI 依專案說明與群組記憶選擇目標儲存庫。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS group_projects (
 group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(group_id,project_id)
);
INSERT INTO group_projects(group_id,project_id) SELECT id,project_id FROM groups WHERE project_id IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE groups SET project_id=NULL WHERE project_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS group_memories (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
 project_id uuid REFERENCES projects(id) ON DELETE CASCADE, content text NOT NULL, source text NOT NULL,
 source_message_id text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tasks ALTER COLUMN project_id DROP NOT NULL;
UPDATE settings SET value='{"ai_mode":"subscription","daily_runs":20}'::jsonb || value WHERE id=1;
-- 需求不明確時 AI 提出的建議方案；管理者可在看板或 LINE 私訊一鍵採用。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggestions jsonb NOT NULL DEFAULT '[]';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS quick_replies jsonb;
-- 專案知識：群組要求記住的開發規範、程式風格與背景知識；開發時帶入，並以 PR 寫進目標專案的 AGENTS.md。
CREATE TABLE IF NOT EXISTS project_knowledge (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 group_id text REFERENCES groups(id) ON DELETE SET NULL, content text NOT NULL, source text NOT NULL,
 source_message_id text, status text NOT NULL DEFAULT 'pending', pr_number integer, pr_url text,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- 訂閱模式的模型與思考程度；codex_model 為 null 時使用 Codex 預設模型。
UPDATE settings SET value='{"codex_model":null,"triage_effort":"high","coding_effort":"medium"}'::jsonb || value WHERE id=1;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS embeddings (
 id bigserial PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('message','task','memory','knowledge','repo','outcome')),
 ref_id text NOT NULL,
 group_id text REFERENCES groups(id) ON DELETE CASCADE,
 project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
 sha text,
 chunk int NOT NULL DEFAULT 0,
 path text,
 content text CHECK (content IS NULL OR kind IN ('repo','outcome')),
 embedding vector(1024) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_ref_idx ON embeddings(kind,ref_id,chunk,COALESCE(sha,''));
CREATE INDEX IF NOT EXISTS embeddings_cosine_idx ON embeddings USING hnsw(embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS embeddings_group_idx ON embeddings(kind,group_id);
CREATE INDEX IF NOT EXISTS embeddings_project_idx ON embeddings(kind,project_id,sha);
UPDATE settings SET value=value || '{"rag_enabled":false}'::jsonb WHERE id=1 AND NOT value ? 'rag_enabled';
UPDATE settings SET value=value || '{"triage_paused":false}'::jsonb WHERE id=1 AND NOT value ? 'triage_paused';
-- 待辦只存識別碼。來源修改與失效在同一交易內標記；向量運算在背景執行。
CREATE TABLE IF NOT EXISTS rag_pending (
 kind text NOT NULL, ref_id text NOT NULL, ticket uuid NOT NULL DEFAULT gen_random_uuid(),
 backfill boolean NOT NULL DEFAULT false, available_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,ref_id)
);
CREATE INDEX IF NOT EXISTS rag_pending_available ON rag_pending(available_at);
CREATE TABLE IF NOT EXISTS rag_backfill (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), active boolean NOT NULL DEFAULT false, completed_at timestamptz
);
INSERT INTO rag_backfill(id) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS rag_references (
 audit_id bigint PRIMARY KEY REFERENCES audit(id) ON DELETE CASCADE,
 message_ids text[] NOT NULL, task_ids uuid[] NOT NULL
);

CREATE OR REPLACE FUNCTION message_retention_cutoff() RETURNS timestamptz LANGUAGE sql STABLE AS $cutoff$
 SELECT now() - make_interval(days => (value->>'retention_days')::int) FROM settings WHERE id=1
$cutoff$;
CREATE OR REPLACE FUNCTION run_content_visible(rid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT r.started_at>message_retention_cutoff() AND NOT EXISTS(
  SELECT 1 FROM unnest(t.source_ids) s(id) LEFT JOIN messages m ON m.id=s.id AND m.group_id=t.group_id
  WHERE m.id IS NULL OR m.revoked OR m.received_at<=message_retention_cutoff()
 ) FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=rid
$$;
CREATE OR REPLACE FUNCTION erase_run_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revoked OR NEW.received_at<=message_retention_cutoff() THEN
  UPDATE run_events SET detail=NULL WHERE run_id IN (
   SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.group_id=NEW.group_id AND NEW.id=ANY(t.source_ids)
  );
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER erase_run_message AFTER INSERT OR UPDATE OF revoked,text,received_at ON messages
 FOR EACH ROW EXECUTE FUNCTION erase_run_content();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_note text;
CREATE TABLE IF NOT EXISTS image_observations (
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
 group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),
 summary text NOT NULL,recognized_text text NOT NULL,uncertainties jsonb NOT NULL DEFAULT '[]',
 intent text NOT NULL CHECK(intent IN ('reference','change_request','uncertain')),source_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_image_refs (
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,task_version integer NOT NULL,message_id text NOT NULL,
 source_hash text NOT NULL CHECK(source_hash~'^[a-f0-9]{64}$'),mime text NOT NULL,origin text NOT NULL CHECK(origin IN ('direct','rag')),
 observation_id uuid,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(task_id,task_version,message_id)
);
CREATE TABLE IF NOT EXISTS task_context_evidence (
 id bigserial PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,version integer NOT NULL,
 phase text NOT NULL,mechanism text NOT NULL,source_kind text NOT NULL,source_id text NOT NULL,project_id uuid,
 source_time timestamptz,score double precision,path text,line_start integer,line_end integer,index_sha text,source_hash text,
 observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION copy_task_image_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO task_image_refs(task_id,task_version,message_id,source_hash,mime,origin,observation_id)
 SELECT task_id,NEW.version,message_id,source_hash,mime,origin,observation_id FROM task_image_refs
 WHERE task_id=NEW.id AND task_version=OLD.version AND message_id=ANY(NEW.source_ids) ON CONFLICT DO NOTHING;
 INSERT INTO task_context_evidence(task_id,version,phase,mechanism,source_kind,source_id,project_id,source_time,score,path,line_start,line_end,index_sha,source_hash)
 SELECT task_id,NEW.version,phase,mechanism,source_kind,source_id,project_id,source_time,score,path,line_start,line_end,index_sha,source_hash
 FROM task_context_evidence WHERE task_id=NEW.id AND version=OLD.version AND phase='triage-selected' AND source_id=ANY(NEW.source_ids);
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER copy_image_version AFTER UPDATE OF version ON tasks FOR EACH ROW
 WHEN (NEW.version<>OLD.version) EXECUTE FUNCTION copy_task_image_refs();
ALTER TABLE embeddings DROP CONSTRAINT IF EXISTS embeddings_kind_check;
ALTER TABLE embeddings ADD CONSTRAINT embeddings_kind_check CHECK(kind IN ('message','task','memory','knowledge','repo','outcome','image'));
CREATE OR REPLACE VIEW rag_sources AS
 SELECT 'message'::text kind, id ref_id, group_id, NULL::uuid project_id, text AS content, received_at AS source_time
 FROM messages WHERE type='text' AND NOT revoked AND text IS NOT NULL AND text<>''
 AND received_at > message_retention_cutoff()
 UNION ALL
 SELECT 'image',o.message_id,o.group_id,NULL::uuid,concat_ws(E'\n',o.summary,o.recognized_text,
   CASE WHEN o.uncertainties<>'[]'::jsonb THEN '辨識不確定：'||o.uncertainties::text END),m.received_at
 FROM image_observations o JOIN messages m ON m.id=o.message_id AND m.group_id=o.group_id
 WHERE NOT m.revoked AND m.received_at>message_retention_cutoff() AND m.image IS NOT NULL AND encode(sha256(m.image),'hex')=o.source_hash
 UNION ALL
 SELECT 'task', id::text, group_id, project_id, concat_ws(E'\n',title,summary,acceptance::text), updated_at
 FROM tasks t WHERE project_id IS NULL OR EXISTS (SELECT 1 FROM group_projects g WHERE g.group_id=t.group_id AND g.project_id=t.project_id)
 UNION ALL
 SELECT 'memory', id::text, group_id, project_id, content, created_at FROM group_memories m
 WHERE project_id IS NULL OR EXISTS (SELECT 1 FROM group_projects g WHERE g.group_id=m.group_id AND g.project_id=m.project_id)
 UNION ALL
 SELECT 'knowledge', id::text, NULL::text, project_id, content, created_at FROM project_knowledge k
 WHERE status<>'closed' AND EXISTS (SELECT 1 FROM group_projects g WHERE g.project_id=k.project_id)
 UNION ALL
 SELECT 'outcome', id::text, group_id, project_id,
   concat_ws(E'\n', '標題：'||left(title,200), '需求：'||left(summary,1200),
     '審查：'||left(nullif(review_note,''),800),
     CASE WHEN status='failed' THEN '失敗原因：'||left(coalesce(last_error,'未記錄'),800) END,
     CASE status WHEN 'merged' THEN '狀態：已合併' WHEN 'ready' THEN '狀態：待合併' ELSE '狀態：需要處理，未合併' END), updated_at
 FROM tasks t WHERE status IN ('ready','merged','failed') AND project_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM group_projects g WHERE g.group_id=t.group_id AND g.project_id=t.project_id);

CREATE OR REPLACE FUNCTION rag_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text := TG_ARGV[0]; rid text; eligible boolean := true;
BEGIN
 IF TG_OP='DELETE' THEN rid := OLD.id::text; eligible := false;
 ELSE
   rid := NEW.id::text;
   IF k='message' THEN eligible := NOT NEW.revoked AND NEW.type='text' AND coalesce(NEW.text,'')<>'';
   ELSIF k='outcome' THEN eligible := NEW.project_id IS NOT NULL AND NEW.status IN ('ready','merged','failed');
   ELSIF k='knowledge' THEN eligible := NEW.status<>'closed';
   END IF;
 END IF;
 IF eligible AND (SELECT (value->>'rag_enabled')::boolean FROM settings WHERE id=1) THEN
   INSERT INTO rag_pending(kind,ref_id) VALUES(k,rid) ON CONFLICT(kind,ref_id) DO UPDATE
   SET ticket=gen_random_uuid(),available_at=now();
 ELSIF eligible THEN
   UPDATE rag_pending SET ticket=gen_random_uuid(),available_at=now() WHERE kind=k AND ref_id=rid;
 ELSE
   DELETE FROM rag_pending WHERE kind=k AND ref_id=rid;
 END IF;
 DELETE FROM embeddings WHERE kind=k AND ref_id=rid;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER rag_message AFTER INSERT OR DELETE OR UPDATE OF text,revoked,received_at ON messages
 FOR EACH ROW EXECUTE FUNCTION rag_source_changed('message');
CREATE OR REPLACE TRIGGER rag_task AFTER INSERT OR DELETE OR UPDATE OF title,summary,acceptance,version,project_id ON tasks
 FOR EACH ROW EXECUTE FUNCTION rag_source_changed('task');
CREATE OR REPLACE TRIGGER rag_outcome AFTER INSERT OR DELETE OR UPDATE OF status,title,summary,review_note,last_error,project_id ON tasks
 FOR EACH ROW EXECUTE FUNCTION rag_source_changed('outcome');
CREATE OR REPLACE TRIGGER rag_memory AFTER INSERT OR DELETE OR UPDATE OF content,project_id ON group_memories
 FOR EACH ROW EXECUTE FUNCTION rag_source_changed('memory');
CREATE OR REPLACE TRIGGER rag_knowledge AFTER INSERT OR DELETE OR UPDATE OF content,status,project_id ON project_knowledge
 FOR EACH ROW EXECUTE FUNCTION rag_source_changed('knowledge');
CREATE OR REPLACE FUNCTION image_observation_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mid text;
BEGIN
 IF TG_OP='DELETE' THEN mid:=OLD.message_id; ELSE mid:=NEW.message_id; END IF;
 DELETE FROM embeddings WHERE kind='image' AND ref_id=mid;
 DELETE FROM rag_pending WHERE kind='image' AND ref_id=mid;
 IF TG_OP<>'DELETE' AND (SELECT (value->>'rag_enabled')::boolean FROM settings WHERE id=1) THEN
   INSERT INTO rag_pending(kind,ref_id) VALUES('image',mid) ON CONFLICT(kind,ref_id) DO UPDATE SET ticket=gen_random_uuid(),available_at=now();
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER rag_image_observation AFTER INSERT OR UPDATE OR DELETE ON image_observations
 FOR EACH ROW EXECUTE FUNCTION image_observation_changed();
CREATE OR REPLACE FUNCTION discard_image_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM image_observations WHERE message_id=NEW.id AND (NEW.revoked OR NEW.received_at<=message_retention_cutoff()
   OR NEW.image IS NULL OR source_hash<>encode(sha256(NEW.image),'hex'));
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER erase_image_observation AFTER UPDATE OF image,revoked,received_at ON messages
 FOR EACH ROW EXECUTE FUNCTION discard_image_observation();

CREATE OR REPLACE FUNCTION rag_binding_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF (SELECT (value->>'rag_enabled')::boolean FROM settings WHERE id=1) THEN
     INSERT INTO rag_pending(kind,ref_id)
     SELECT s.kind,s.ref_id FROM rag_sources s WHERE s.project_id=NEW.project_id AND (s.group_id IS NULL OR s.group_id=NEW.group_id)
     AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.kind=s.kind AND e.ref_id=s.ref_id)
     ON CONFLICT DO NOTHING;
   END IF;
 ELSE
   DELETE FROM rag_pending p WHERE
     (p.kind IN ('task','outcome') AND EXISTS(SELECT 1 FROM tasks t WHERE t.id::text=p.ref_id AND t.group_id=OLD.group_id AND t.project_id=OLD.project_id)) OR
     (p.kind='memory' AND EXISTS(SELECT 1 FROM group_memories m WHERE m.id::text=p.ref_id AND m.group_id=OLD.group_id AND m.project_id=OLD.project_id)) OR
     (p.kind='knowledge' AND NOT EXISTS(SELECT 1 FROM group_projects WHERE project_id=OLD.project_id)
      AND EXISTS(SELECT 1 FROM project_knowledge k WHERE k.id::text=p.ref_id AND k.project_id=OLD.project_id));
   DELETE FROM embeddings WHERE project_id=OLD.project_id AND
     ((kind IN ('task','memory','outcome') AND group_id=OLD.group_id) OR
      (kind='knowledge' AND NOT EXISTS(SELECT 1 FROM group_projects WHERE project_id=OLD.project_id)));
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER rag_binding AFTER INSERT OR DELETE ON group_projects
 FOR EACH ROW EXECUTE FUNCTION rag_binding_changed();

ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS line_start integer;
ALTER TABLE embeddings ADD COLUMN IF NOT EXISTS line_end integer;
CREATE TABLE IF NOT EXISTS repo_indexes(
 project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 wanted_sha text NOT NULL, active_sha text, generation uuid NOT NULL DEFAULT gen_random_uuid(),
 phase text NOT NULL CHECK(phase IN ('queued','indexing','ready','failed')),
 chunks integer NOT NULL DEFAULT 0, error text, retry_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE repo_indexes ADD COLUMN IF NOT EXISTS total_chunks integer;
ALTER TABLE repo_indexes ADD COLUMN IF NOT EXISTS truncated boolean NOT NULL DEFAULT false;
ALTER TABLE repo_indexes DROP CONSTRAINT IF EXISTS repo_indexes_phase_check;
ALTER TABLE repo_indexes ADD CONSTRAINT repo_indexes_phase_check CHECK(phase IN ('queued','indexing','ready','failed','limited'));

CREATE OR REPLACE FUNCTION discard_repo_index() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='group_projects' THEN
   PERFORM 1 FROM projects WHERE id=OLD.project_id FOR UPDATE;
   IF EXISTS(SELECT 1 FROM group_projects WHERE project_id=OLD.project_id) THEN RETURN NULL; END IF;
   DELETE FROM repo_indexes WHERE project_id=OLD.project_id;
   DELETE FROM embeddings WHERE project_id=OLD.project_id AND kind='repo';
 ELSE
   DELETE FROM repo_indexes WHERE project_id=NEW.id;
   DELETE FROM embeddings WHERE project_id=NEW.id AND kind='repo';
 END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER repo_unbound AFTER DELETE ON group_projects FOR EACH ROW EXECUTE FUNCTION discard_repo_index();
CREATE OR REPLACE TRIGGER repo_reconfigured AFTER UPDATE OF config_version ON projects FOR EACH ROW
 WHEN (OLD.config_version IS DISTINCT FROM NEW.config_version) EXECUTE FUNCTION discard_repo_index();

-- 更新檔案安全規則後，舊版本的片段也必須重新篩選；重啟後保留已重建的索引。
CREATE TABLE IF NOT EXISTS rag_migrations(name text PRIMARY KEY);
DO $migration$
BEGIN
 INSERT INTO rag_migrations VALUES('repo_completeness_v1') ON CONFLICT DO NOTHING;
 IF FOUND THEN
  -- 舊版恰好5000段不能證明完整；清除其可見版本，重新核對總數。
  DELETE FROM embeddings WHERE kind='repo' AND project_id IN (SELECT project_id FROM repo_indexes WHERE chunks>=5000);
  UPDATE repo_indexes SET phase='queued',active_sha=NULL,chunks=0,total_chunks=NULL,truncated=false,retry_at=now(),error='既有索引達上限，重新核對總段數' WHERE chunks>=5000;
 END IF;
END $migration$;
DO $migration$
BEGIN
 INSERT INTO rag_migrations VALUES('repo_source_filter_v2') ON CONFLICT DO NOTHING;
 IF FOUND THEN
   DELETE FROM repo_indexes;
   DELETE FROM embeddings WHERE kind='repo';
 END IF;
END $migration$;

-- 一次性固定升級前圖片任務的當前來源；後續 migrate 不可認領變更後的新內容。
DO $legacy_images$
BEGIN
 INSERT INTO rag_migrations VALUES('task_image_refs_legacy_v1') ON CONFLICT DO NOTHING;
 IF FOUND THEN
   INSERT INTO task_image_refs(task_id,task_version,message_id,source_hash,mime,origin,observation_id)
   SELECT t.id,t.version,m.id,encode(sha256(m.image),'hex'),m.image_mime,'direct',o.id
   FROM tasks t JOIN messages m ON m.id=ANY(t.source_ids) AND m.group_id=t.group_id
   LEFT JOIN image_observations o ON o.message_id=m.id AND o.group_id=m.group_id
     AND o.source_hash=encode(sha256(m.image),'hex')
   WHERE m.type='image' AND NOT m.revoked AND m.received_at>message_retention_cutoff()
     AND m.image IS NOT NULL AND octet_length(m.image) BETWEEN 1 AND 10485760
     AND m.image_mime IN ('image/png','image/jpeg','image/webp','image/gif')
   ON CONFLICT(task_id,task_version,message_id) DO NOTHING;

   -- 無效圖片不能被遷移重新授權。保留來源識別碼並撤銷核准，讓看板明確提示。
   WITH affected AS (
     UPDATE tasks t SET status='awaiting_approval',approved_version=NULL,version=version+1,
       approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,
       missing=missing || '["升級時圖片來源已撤回、到期、無法取得或不屬於本群組，請重新確認有效來源"]'::jsonb,
       last_error='圖片來源無法固定到需求版本，請重新確認有效來源',updated_at=now()
     WHERE t.status IN ('queued','budget_wait','awaiting_approval','failed','running','reviewing')
       AND EXISTS(SELECT 1 FROM messages m WHERE m.id=ANY(t.source_ids) AND m.type='image'
         AND (m.group_id<>t.group_id OR m.revoked OR m.received_at<=message_retention_cutoff()
           OR m.image IS NULL OR octet_length(m.image) NOT BETWEEN 1 AND 10485760
           OR m.image_mime IS NULL OR m.image_mime NOT IN ('image/png','image/jpeg','image/webp','image/gif')))
     RETURNING id
   ) INSERT INTO audit(task_id,kind,detail)
     SELECT id,'migration','圖片來源無效；升級已撤銷舊核准，等待重新確認' FROM affected;
 END IF;
END $legacy_images$;

CREATE INDEX IF NOT EXISTS tasks_sources_gin ON tasks USING gin(source_ids);
CREATE TABLE IF NOT EXISTS chat_revision(id integer PRIMARY KEY CHECK(id=1),revision bigint NOT NULL DEFAULT 0);
INSERT INTO chat_revision(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION touch_chat_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE chat_revision SET revision=revision+1 WHERE id=1;
 RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER messages_changed AFTER INSERT OR UPDATE OR DELETE ON messages
 FOR EACH STATEMENT EXECUTE FUNCTION touch_chat_revision();
-- 聊天室顯示的 LINE 成員名稱快取；訊息到期清除發話者後一併刪除。
CREATE TABLE IF NOT EXISTS line_members (
 group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE, user_id text NOT NULL,
 display_name text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(group_id,user_id)
);
-- 群組名稱以 LINE 為準，記錄最後同步時間以免每則訊息都查詢。
ALTER TABLE groups ADD COLUMN IF NOT EXISTS name_synced_at timestamptz;
-- 查詢任務：只調查並回覆，不修改程式、不開 PR；調查結果存在 answer。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'change';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS answer text;
-- 看板成員：擁有者（ADMIN_GITHUB_ID）永遠是管理者；其他人由管理者在看板加入。
CREATE TABLE IF NOT EXISTS members (
 github_id text PRIMARY KEY, login text NOT NULL, role text NOT NULL CHECK(role IN ('admin','member')),
 added_by text, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS login text;
-- 看板通知鈴鐺：每位使用者看過通知的時間。
CREATE TABLE IF NOT EXISTS alert_seen (user_id text PRIMARY KEY, seen_at timestamptz NOT NULL DEFAULT now());
-- 舊時間軸紀錄改成易讀格式：去掉判讀附帶的上下文 JSON；「管理者 <ID> 操作需求版本 N」改寫成帳號名稱與實際動作。
UPDATE audit SET detail=regexp_replace(detail,'；上下文範圍 \{.*$','') WHERE kind='retrieval' AND detail LIKE '%；上下文範圍 {%';
UPDATE audit a SET detail=coalesce(
  (SELECT s.login FROM sessions s WHERE s.user_id=x.m[1] AND s.login IS NOT NULL ORDER BY s.expires_at DESC LIMIT 1),
  (SELECT mb.login FROM members mb WHERE mb.github_id=x.m[1]),
  x.m[1]) || ' ' || CASE a.kind WHEN 'approve' THEN '核准' WHEN 'reject' THEN '拒絕' WHEN 'cancel' THEN '取消' WHEN 'retry' THEN '重試'
    WHEN 'amend' THEN '補充需求' WHEN 'assign' THEN '指定專案' WHEN 'adopt' THEN '採用方案' WHEN 'mode' THEN '切換任務類型' ELSE '操作' END
  || '（需求版本 ' || x.m[2] || '）'
FROM (SELECT id, regexp_match(detail,'^管理者 (\S+) 操作需求版本 (\d+)$') AS m FROM audit WHERE detail LIKE '管理者 % 操作需求版本 %') x
WHERE x.id=a.id AND x.m IS NOT NULL;
-- 一次性整理舊資料：過長的驗證／失敗紀錄只留開頭重點（完整輸出仍在執行紀錄），
-- 在固定字數被切斷、沒有刪節號的失敗原因補上「…」；新紀錄寫入時已自行截短。
DO $migration$
BEGIN
 INSERT INTO rag_migrations VALUES('audit_tidy_v1') ON CONFLICT DO NOTHING;
 IF FOUND THEN
  UPDATE audit SET detail=btrim(coalesce(nullif(regexp_replace(left(detail,600),'[^。！？\n]*$',''),''),left(detail,600)),E' \n\r')||'…（完整內容見執行紀錄）'
   WHERE kind IN ('verification','error') AND length(detail)>1600;
  UPDATE audit SET detail=detail||'…'
   WHERE kind IN ('verification','error') AND length(detail)>=280 AND right(detail,1) NOT IN ('。','！','？','…','）',')','.','」');
  UPDATE tasks SET last_error=last_error||'…'
   WHERE length(last_error)>=280 AND right(last_error,1) NOT IN ('。','！','？','…','）',')','.','」');
 END IF;
END $migration$;
-- 補建索引完成也算一次確認：設定頁「向量索引」的時間不早於最近一次補建完成。
UPDATE service_health h SET checked_at=b.completed_at FROM rag_backfill b
 WHERE h.name='rag_index' AND h.ok AND b.completed_at>h.checked_at;
-- 儲存庫在 GitHub 上已刪除或 App 失去存取權的時間；有值時專案停用且不可綁定群組。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_missing_at timestamptz;
-- 儲存庫搬家或改名時靠 GitHub 的固定編號找回來；找不到時先記下原本的啟用狀態、群組綁定與交回人工的任務，接回後自動復原。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_id bigint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS repo_missing_state jsonb;

CREATE TABLE IF NOT EXISTS query_report_images (
 id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,version integer NOT NULL,
 key text NOT NULL CHECK(key~'^[a-zA-Z0-9_-]{1,40}$'),
 position smallint NOT NULL CHECK(position BETWEEN 0 AND 2),
 caption text NOT NULL,kind text NOT NULL CHECK(kind IN ('message','repository','screenshot')),
 source text NOT NULL,captured_at timestamptz,
 mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
 data bytea NOT NULL CHECK(octet_length(data) BETWEEN 1 AND 2097152),
 UNIQUE(task_id,version,key),UNIQUE(task_id,version,position)
);
CREATE OR REPLACE FUNCTION query_report_image_visible(iid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT t.version=i.version AND t.mode='query' AND t.status='answered'
 AND r.task_id=t.id AND r.version=i.version AND run_content_visible(r.id)
 AND NOT EXISTS (
  SELECT 1 FROM task_image_refs ref LEFT JOIN messages m ON m.id=ref.message_id AND m.group_id=t.group_id
  WHERE ref.task_id=t.id AND ref.task_version=i.version AND
   (m.id IS NULL OR m.revoked OR m.received_at<=message_retention_cutoff() OR m.image IS NULL
    OR ref.source_hash<>encode(sha256(m.image),'hex') OR ref.mime IS DISTINCT FROM m.image_mime)
 )
 FROM query_report_images i JOIN tasks t ON t.id=i.task_id JOIN runs r ON r.id=i.run_id WHERE i.id=iid
$$;

-- 專案確認只對同一需求、專案設定及群組綁定版本有效。
ALTER TABLE groups ADD COLUMN IF NOT EXISTS binding_version integer NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_routing jsonb NOT NULL DEFAULT '{"status":"uncertain","basis":"none","reason":"請確認目標專案","evidence":[],"bindingVersion":0}';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS target_branch text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS branch_selection jsonb NOT NULL DEFAULT '{"basis":"uncertain","reason":"請確認目標分支","sourceIds":[]}';
CREATE TABLE IF NOT EXISTS task_project_confirmations (
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,version integer NOT NULL,
 project_id uuid NOT NULL,config_version integer NOT NULL,binding_version integer NOT NULL,
 mode text NOT NULL CHECK(mode IN ('change','query')),kind text NOT NULL CHECK(kind IN ('manual','evidence')),
 actor text NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(task_id,version)
);
ALTER TABLE task_project_confirmations DROP CONSTRAINT IF EXISTS task_project_confirmations_project_id_fkey;
ALTER TABLE task_project_confirmations ADD COLUMN IF NOT EXISTS target_branch text;
CREATE OR REPLACE FUNCTION initialize_task_target_branch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.target_branch IS NULL THEN SELECT base_branch INTO NEW.target_branch FROM projects WHERE id=NEW.project_id; END IF;
 ELSIF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
  SELECT base_branch INTO NEW.target_branch FROM projects WHERE id=NEW.project_id;
  NEW.branch_selection:='{"basis":"uncertain","reason":"專案已更換，請確認本次目標分支","sourceIds":[]}';
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER task_target_branch_default BEFORE INSERT OR UPDATE OF project_id ON tasks
 FOR EACH ROW EXECUTE FUNCTION initialize_task_target_branch();
CREATE OR REPLACE FUNCTION task_project_confirmed(tid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM tasks t JOIN task_project_confirmations a ON a.task_id=t.id AND a.version=t.version
 JOIN projects p ON p.id=t.project_id JOIN groups g ON g.id=t.group_id
 JOIN group_projects gp ON gp.group_id=g.id AND gp.project_id=p.id
 WHERE t.id=tid AND a.project_id=p.id AND a.config_version=p.config_version AND a.binding_version=g.binding_version
 AND t.target_branch IS NOT NULL AND a.target_branch=t.target_branch
 AND a.mode=t.mode AND (a.kind='manual' OR (t.mode='query' AND t.project_routing->>'status'='clear'
 AND (t.project_routing->>'bindingVersion')::integer=g.binding_version)))
$$;
CREATE OR REPLACE FUNCTION invalidate_project_confirmations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gid text; pid uuid; reason text;
BEGIN
 IF TG_TABLE_NAME='group_projects' THEN
  gid:=CASE WHEN TG_OP='DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  UPDATE groups SET binding_version=binding_version+1 WHERE id=gid;
  reason:='群組綁定已變更，請重新確認目標專案';
 ELSE
  IF NEW.config_version=OLD.config_version THEN RETURN NEW; END IF;
  pid:=NEW.id;
  reason:='專案設定已變更，請重新確認目標專案';
 END IF;
 UPDATE tasks t SET status='awaiting_approval',approved_version=NULL,version=version+1,
  project_id=CASE WHEN gid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM group_projects gp WHERE gp.group_id=gid AND gp.project_id=t.project_id) THEN NULL ELSE t.project_id END,
  approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,
  project_routing=jsonb_build_object('status','uncertain','basis','none','reason',reason,'evidence','[]'::jsonb,'bindingVersion',0),
  last_error=CASE WHEN t.status='awaiting_approval' AND t.project_id IS NULL AND t.last_error IS NOT NULL THEN t.last_error ELSE reason END,updated_at=now()
 WHERE (t.group_id=gid OR t.project_id=pid) AND t.status IN ('awaiting_approval','queued','budget_wait','failed','running','reviewing');
 INSERT INTO task_versions(task_id,version,summary,acceptance)
 SELECT id,version,summary,acceptance FROM tasks t WHERE (t.group_id=gid OR t.project_id=pid) AND t.status='awaiting_approval' AND t.project_routing->>'reason'=reason
 ON CONFLICT DO NOTHING;
 INSERT INTO notifications(task_id,kind,dedupe_key,text)
 SELECT t.id,'approval','approval:'||t.id||':'||t.version,
  '待確認'||CASE WHEN t.mode='query' THEN '查詢' ELSE '修改' END||'：'||t.title||E'\n目標專案：'||
  coalesce((SELECT p.name||'（'||p.repo||'）' FROM projects p WHERE p.id=t.project_id),'尚未指定')||E'\n目標分支：'||coalesce(t.target_branch,'尚未選擇')||E'\n'||reason||'。請到看板確認。' FROM tasks t
 WHERE (t.group_id=gid OR t.project_id=pid) AND t.status='awaiting_approval' AND t.last_error=reason
 ON CONFLICT DO NOTHING;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE OR REPLACE TRIGGER project_confirmation_binding AFTER INSERT OR DELETE ON group_projects
 FOR EACH ROW EXECUTE FUNCTION invalidate_project_confirmations();
CREATE OR REPLACE TRIGGER project_confirmation_config AFTER UPDATE OF config_version ON projects
 FOR EACH ROW EXECUTE FUNCTION invalidate_project_confirmations();
DO $migration$
BEGIN
 INSERT INTO rag_migrations VALUES('project_confirmation_v1') ON CONFLICT DO NOTHING;
 IF FOUND THEN
  UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,
   approved_paths='{}',pending_paths='{}',base_sha=NULL,branch=NULL,last_error='專案確認規則已更新，請到看板確認目標專案',updated_at=now()
  WHERE status IN ('awaiting_approval','queued','budget_wait','failed') AND NOT task_project_confirmed(id);
  INSERT INTO task_versions(task_id,version,summary,acceptance)
  SELECT id,version,summary,acceptance FROM tasks WHERE status='awaiting_approval' ON CONFLICT DO NOTHING;
  INSERT INTO notifications(task_id,kind,dedupe_key,text)
  SELECT t.id,'approval','approval:'||t.id||':'||t.version,'待確認'||CASE WHEN t.mode='query' THEN '查詢' ELSE '修改' END||'：'||t.title||E'\n目標專案：'||
   coalesce((SELECT p.name||'（'||p.repo||'）' FROM projects p WHERE p.id=t.project_id),'尚未指定')||E'\n目標分支：'||coalesce(t.target_branch,'尚未選擇')||E'\n專案確認規則已更新，請到看板檢視後核准。'
  FROM tasks t WHERE t.status='awaiting_approval' ON CONFLICT DO NOTHING;
 END IF;
END $migration$;

DO $migration$
BEGIN
 INSERT INTO rag_migrations VALUES('task_target_branch_v1') ON CONFLICT DO NOTHING;
 IF FOUND THEN
  UPDATE tasks t SET target_branch=p.base_branch FROM projects p WHERE t.project_id=p.id AND t.target_branch IS NULL
   AND t.status IN ('awaiting_approval','queued','budget_wait','failed');
  UPDATE tasks SET status='awaiting_approval',approved_version=NULL,version=version+1,base_sha=NULL,branch=NULL,
   approved_paths='{}',pending_paths='{}',last_error='任務現在需要確認目標分支，請重新檢視儲存庫與分支',updated_at=now()
   WHERE status IN ('awaiting_approval','queued','budget_wait','failed') AND NOT task_project_confirmed(id);
  INSERT INTO task_versions(task_id,version,summary,acceptance)
   SELECT id,version,summary,acceptance FROM tasks WHERE status='awaiting_approval' ON CONFLICT DO NOTHING;
  INSERT INTO notifications(task_id,kind,dedupe_key,text)
   SELECT t.id,'approval','approval:'||t.id||':'||t.version,'待確認'||CASE WHEN t.mode='query' THEN '查詢' ELSE '修改' END||'：'||t.title||E'\n專案：'||coalesce((SELECT p.name||'（'||p.repo||'）' FROM projects p WHERE p.id=t.project_id),'尚未指定')||E'\n分支：'||coalesce(t.target_branch,'尚未選擇')||E'\n請到看板核對儲存庫與分支後確認。'
   FROM tasks t WHERE t.last_error='任務現在需要確認目標分支，請重新檢視儲存庫與分支' ON CONFLICT DO NOTHING;
 END IF;
END $migration$;
-- 機器人離開群組的時間；重新加入或群組再傳訊息時清除。離開期間不能啟用。
ALTER TABLE groups ADD COLUMN IF NOT EXISTS left_at timestamptz;
-- 新群組是否已通知管理者。升級前就存在的群組視為已通知，之後新增的才會通知。
DO $announce$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='groups' AND column_name='announced_at') THEN
  ALTER TABLE groups ADD COLUMN announced_at timestamptz DEFAULT now();
  ALTER TABLE groups ALTER COLUMN announced_at DROP DEFAULT;
 END IF;
END $announce$;
-- 群組回覆範圍：off 不回覆、results 只回覆結果、all 另外通知已收到。群組推播計入 LINE 推播額度。
ALTER TABLE groups ADD COLUMN IF NOT EXISTS reply_mode text NOT NULL DEFAULT 'results' CHECK(reply_mode IN ('off','results','all'));
-- 有值時送到該群組，沒有值時送給已配對的管理者。
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_id text;
-- 擁有者登記的專案資料庫連線：機密欄位加密保存，不回傳給瀏覽器，也不進每日備份。
CREATE TABLE IF NOT EXISTS project_connections (
 project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 engine text NOT NULL CHECK(engine IN ('sqlserver')),
 host text NOT NULL, port int NOT NULL, database_name text NOT NULL, username text NOT NULL,
 encrypt boolean NOT NULL DEFAULT true, trust_server_certificate boolean NOT NULL DEFAULT true,
 ssh_host text, ssh_port int, ssh_username text, ssh_host_key text,
 reference_tables text[] NOT NULL DEFAULT '{}',
 secret bytea NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
-- 最近一次擷取的資料庫結構快照；只有結構與擁有者明確指定的參考資料表。
CREATE TABLE IF NOT EXISTS project_schema_snapshots (
 project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 version int NOT NULL, engine text NOT NULL, hash text NOT NULL,
 objects jsonb NOT NULL, tables jsonb NOT NULL, reference_rows int NOT NULL DEFAULT 0,
 warnings jsonb NOT NULL DEFAULT '[]', files jsonb NOT NULL, bytes int NOT NULL,
 captured_at timestamptz NOT NULL DEFAULT now(), captured_by text
);
-- 最近一次告知管理者的服務狀態；正常與異常互換時才通知，持續異常不重複通知。
ALTER TABLE service_health ADD COLUMN IF NOT EXISTS notified_ok boolean;
-- 機器人送出的 LINE 訊息 ID：群組成員用「回覆」引用機器人的回答時，據此判斷是在接續哪一題。
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_message_id text;
CREATE INDEX IF NOT EXISTS notifications_sent_message ON notifications(sent_message_id) WHERE sent_message_id IS NOT NULL;
-- 定期檢查：AI 或管理者寫好檢查定義，人核准後由系統依排程執行，不再呼叫 AI；狀態改變時才通知。
CREATE TABLE IF NOT EXISTS scheduled_checks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 group_id text NOT NULL REFERENCES groups(id),
 project_id uuid REFERENCES projects(id),
 name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('sql','http','tcp')),
 target text NOT NULL,
 condition jsonb NOT NULL DEFAULT '{}',
 interval_minutes int CHECK(interval_minutes IS NULL OR interval_minutes>=15),
 daily_at text CHECK(daily_at IS NULL OR daily_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 notify text NOT NULL DEFAULT 'both' CHECK(notify IN ('group','admin','both')),
 quiet_from text, quiet_to text,
 alert_text text NOT NULL DEFAULT '',
 recovered_text text NOT NULL DEFAULT '',
 rationale text NOT NULL DEFAULT '',
 investigate boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'awaiting_approval' CHECK(status IN ('awaiting_approval','active','paused','failed')),
 version int NOT NULL DEFAULT 1,
 approved_version int,
 approved_by text,
 state text NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','ok','alert')),
 consecutive_errors int NOT NULL DEFAULT 0,
 last_run_at timestamptz,
 next_run_at timestamptz,
 last_investigated_at timestamptz,
 source_task_id uuid REFERENCES tasks(id),
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((interval_minutes IS NULL) <> (daily_at IS NULL))
);
CREATE INDEX IF NOT EXISTS scheduled_checks_due ON scheduled_checks(next_run_at) WHERE status='active';
-- 每次執行的結果保留 30 天，不進每日備份。
CREATE TABLE IF NOT EXISTS scheduled_check_runs (
 id bigserial PRIMARY KEY,
 check_id uuid NOT NULL REFERENCES scheduled_checks(id) ON DELETE CASCADE,
 version int NOT NULL,
 started_at timestamptz NOT NULL DEFAULT now(),
 duration_ms int NOT NULL DEFAULT 0,
 outcome text NOT NULL CHECK(outcome IN ('ok','alert','error')),
 summary text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS scheduled_check_runs_recent ON scheduled_check_runs(check_id,started_at DESC);
-- 從 LINE 提出的定期檢查：先建立「草擬定期檢查」的查詢任務，記下要求的排程；Codex 寫好定義後建立待核准的檢查。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS check_draft jsonb;
