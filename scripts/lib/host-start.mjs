// 部署停掉主機程序（監督程序、執行器、通道）後怎麼把它帶回來（#250）。
// 排程工作「存在」不代表啟動得了：已停用時 Start-ScheduledTask 失敗，舊版部署卻當成成功，
// 正式環境停到有人手動啟動監督程序。這裡只放決策，跟作業系統互動的部分由呼叫端注入。

const TASK = "LINE-AgentFlow";

/**
 * 開機排程工作是否有效。state 是 Get-ScheduledTask 的 State（Ready、Running、Disabled…），
 * undefined 表示沒有這個排程工作。
 */
export function startupTaskCheck(state) {
  if (state === undefined)
    return {
      usable: false,
      detail: `沒有排程工作 ${TASK}，重開機後主機程序不會自動啟動；執行 npm run install:startup 註冊`,
    };
  if (state === "Disabled")
    return {
      usable: false,
      detail: `排程工作 ${TASK} 已停用，重開機後主機程序不會自動啟動；執行 npm run install:startup 重新註冊，或 Enable-ScheduledTask -TaskName '${TASK}'`,
    };
  return { usable: true, detail: `排程工作 ${TASK}：${state}` };
}

/**
 * 決定監督程序要走哪條路回來。started：Start-ScheduledTask 是否成功；
 * appeared：啟動後監督程序是否在時限內出現。排程工作無效時兩者都不必提供。
 */
export function hostStartRoute({ taskState, started, appeared }) {
  const check = startupTaskCheck(taskState);
  if (!check.usable) return { route: "direct", reason: check.detail };
  if (!started)
    return { route: "direct", reason: `啟動排程工作 ${TASK} 的指令失敗` };
  if (!appeared)
    return {
      route: "direct",
      reason: `排程工作 ${TASK} 啟動後沒有出現監督程序`,
    };
  return { route: "task" };
}

async function appears(io, seconds) {
  for (let left = seconds; ; left -= 2) {
    if (io.supervisorRunning()) return true;
    if (left <= 0) return false;
    await io.wait(2000);
  }
}

/**
 * 帶回監督程序：先試排程工作，確認程序真的出現；不行就直接在背景啟動，再確認一次。
 * 監督程序用 .local/supervisor.pid 防止重複，兩條路都走到也只會有一個。
 */
export async function bringHostBack(io, { seconds = 20 } = {}) {
  const taskState = io.taskState();
  let started;
  let appeared;
  if (startupTaskCheck(taskState).usable) {
    started = io.startTask();
    appeared = started && (await appears(io, seconds));
  }
  const decision = hostStartRoute({ taskState, started, appeared });
  if (decision.route === "task") return { ...decision, running: true };
  io.startDirect();
  return { ...decision, running: await appears(io, seconds) };
}

/** 部署失敗時印出的狀態：哪些東西停著、怎麼恢復。 */
export function hostStateAdvice({ supervisor, runner, app, taskState }) {
  const lines = [];
  if (!supervisor) {
    const start = `Start-ScheduledTask -TaskName '${TASK}'`;
    lines.push(
      "✘ 監督程序沒有執行：執行器、通道與容器停了都不會被自動拉回，正式環境無法執行任務。",
      startupTaskCheck(taskState).usable
        ? `  恢復：${start}`
        : `  恢復：在部署目錄執行 npm run install:startup，再執行 ${start}`,
    );
  } else if (!runner)
    lines.push(
      "✘ 執行器沒有回應：監督程序每 30 秒會重新啟動它；持續異常請看 .local\\runner.log。",
    );
  if (!app)
    lines.push(
      "✘ app 沒有回應：請查看 docker compose logs --tail 100 app" +
        (supervisor ? "；監督程序每 30 秒會執行 docker compose up -d。" : "。"),
    );
  if (!lines.length) lines.push("目前監督程序、執行器與 app 都在執行。");
  return lines;
}
