import type { Detail } from "./shared";
import { date } from "./shared";
import {
  contextMechanismLabels,
  contextSourceLabels,
} from "../../shared/context-evidence.js";

export function TaskContextEvidence({ detail }: { detail: Detail }) {
  return (
    <>
      {!!detail.images?.length && (
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            需求版本 {detail.task.version} 的圖片參考
          </h3>
          {detail.images.map((image) => (
            <details key={image.id} className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer">
                {image.origin === "rag" ? "向量檢索找回" : "直接引用"} ·{" "}
                {image.valid ? "有效圖片" : image.reason}
              </summary>
              <p className="mt-2 break-all text-xs text-muted-foreground">
                來源 ID：{image.id}
                <br />
                SHA-256：{image.sha256}
              </p>
              {image.valid && (
                <>
                  <a
                    href={`/api/messages/${encodeURIComponent(image.id)}/image`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="開啟圖片原圖"
                  >
                    <img
                      className="mt-2 max-h-72 max-w-full rounded object-contain"
                      src={`/api/messages/${encodeURIComponent(image.id)}/image`}
                      alt="此需求版本使用的來源圖片"
                    />
                  </a>
                  {image.observation && (
                    <div className="mt-2 space-y-1 whitespace-pre-wrap break-words">
                      <p>畫面摘要：{image.observation.summary}</p>
                      {image.observation.text && (
                        <p>辨識文字：{image.observation.text}</p>
                      )}
                      {!!image.observation.uncertainties.length && (
                        <p>
                          不確定事項：
                          {image.observation.uncertainties.join("；")}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        圖片摘要僅為判讀資料；不代表已核准的指令。
                      </p>
                    </div>
                  )}
                </>
              )}
            </details>
          ))}
        </section>
      )}
      {!!detail.contextEvidence?.length && (
        <details className="min-w-0 rounded-lg border p-3 text-sm">
          <summary className="cursor-pointer">
            上下文來源證據（{detail.contextEvidence.length} 筆）
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            表示本次提供的參考資料，不保證模型採用，也不代表已確認相關性。
          </p>
          <ul className="mt-3 space-y-3">
            {detail.contextEvidence.map((e) => (
              <li key={e.id} className="min-w-0 break-all">
                <p>
                  {contextMechanismLabels[e.mechanism]} ·{" "}
                  {contextSourceLabels[e.source_kind]} · 版本 {e.version} ·{" "}
                  {e.phase === "triage-selected"
                    ? "需求辨識選用的來源"
                    : e.phase === "triage"
                      ? "需求辨識候選資料"
                      : "開發與審查"}
                </p>
                <p className="text-xs text-muted-foreground">
                  來源 ID：{e.source_id}
                </p>
                {e.source_time && (
                  <p>來源時間：{date(String(e.source_time))}</p>
                )}
                {e.score != null && (
                  <p>命中分數：{Number(e.score).toFixed(4)}</p>
                )}
                {e.path && (
                  <p>
                    檔案：{e.path}
                    {e.line_start != null && `：${e.line_start}–${e.line_end}`}
                  </p>
                )}
                {e.index_sha && (
                  <p className="text-xs">索引 SHA：{e.index_sha}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  記錄時間：{date(e.observed_at)}
                  {!e.valid && " · 來源已失效或不在目前可用範圍"}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
