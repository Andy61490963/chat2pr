import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type Docker from "dockerode";
import {
  ContainerDeadline,
  Containers,
  containerPolicy,
} from "../server/containers.js";
import { AppError } from "../server/policy.js";

const worker =
  process.env.ACCEPTANCE_WORKER_IMAGE ?? "line-agentflow-worker:local";
const instance = `verify-limits-${randomUUID().slice(0, 8)}`;
const c = new Containers(instance);

// systemd 可能在最後一個程序退出後先回收 cgroup，讓 containerd 永久漏掉 OOM。
// 留一個小父程序直到真事件與計數均已讀取，不重跑容器、不放寬 OOM 斷言。
// 驗收父程序與 Docker exec 觀測程序需排除於 OOM 候選，只有分配記憶體的
// 子程序提高 oom_score_adj；否則 CI 曾連續 OOM 殺掉控制程序，phase 正常
// 清理容器後，驗收器的晚到 inspect 才顯示 404，誤認產品診斷失敗。
// 來源：https://github.com/containerd/containerd/commit/a47da7e9b392d87f6fac2663fac7b83e10df16e9
const controlledOomScript = `
set -u
test -r /sys/fs/cgroup/memory.events || { echo '需要 cgroup v2 memory.events' >&2; exit 78; }
cat /sys/fs/cgroup/memory.events > /tmp/oom-before
cat /sys/fs/cgroup/memory.max > /tmp/oom-limit
cat /proc/1/oom_score_adj > /tmp/oom-parent-score
touch /tmp/oom-ready
while [ ! -e /tmp/oom-trigger ]; do sleep 0.05; done
node -e "const fs=require('node:fs');fs.writeFileSync('/proc/self/oom_score_adj','1000');fs.writeFileSync('/tmp/oom-child-score',fs.readFileSync('/proc/self/oom_score_adj'));console.log('保留標準輸出');console.error('保留錯誤輸出');const a=[];setInterval(()=>a.push(Buffer.alloc(4*1024*1024,1)),10)"
child_code=$?
cat /sys/fs/cgroup/memory.events > /tmp/oom-after
printf '%s' "$child_code" > /tmp/oom-child-exit
touch /tmp/oom-finished
while [ ! -e /tmp/oom-release ]; do sleep 0.05; done
exit "$child_code"
`;

async function inside(
  container: Docker.Container,
  command: string,
  deadline: ContainerDeadline,
) {
  const exec = await deadline.run(() =>
    container.exec({
      User: "1000:1000",
      Cmd: ["sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
    }),
  );
  const stream = await deadline.run(
    () => exec.start({ Detach: false, Tty: false }),
    (late) => late.destroy(),
  );
  const out = new PassThrough(),
    err = new PassThrough();
  let output = "";
  out.on("data", (chunk) => {
    output += chunk.toString();
  });
  err.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    const drained = new Promise<void>((resolve, reject) => {
      stream.once("end", resolve);
      stream.once("error", reject);
    });
    void drained.catch(() => {});
    c.docker.modem.demuxStream(stream, out, err);
    await deadline.run(() => drained);
    return {
      output,
      exitCode: (await deadline.run(() => exec.inspect())).ExitCode,
    };
  } finally {
    stream.destroy();
    out.destroy();
    err.destroy();
  }
}
async function controlPressure(container: Docker.Container) {
  const deadline = new ContainerDeadline(
    12000,
    new AppError(503, "受控 OOM 驗收逾時"),
  );
  let stream: NodeJS.ReadableStream | undefined;
  const proof: Record<string, unknown> = { containerId: container.id };
  try {
    const daemon = await deadline.run(() => c.docker.info());
    proof.daemon = {
      cgroupDriver: daemon.CgroupDriver,
      cgroupVersion: daemon.CgroupVersion,
      serverVersion: daemon.ServerVersion,
    };
    const events: Array<{ action: string; id: string; timeNano?: number }> = [];
    stream = await deadline.run(
      () =>
        c.docker.getEvents({
          filters: { container: [container.id], event: ["oom", "die"] },
        }),
      (late) => (late as Readable).destroy(),
    );
    let pending = "";
    stream.on("data", (piece: Buffer) => {
      pending += piece.toString();
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        events.push({
          action: event.Action ?? event.status,
          id: event.Actor?.ID ?? event.id,
          timeNano: event.timeNano,
        });
      }
    });
    stream.on("error", () => {});
    proof.events = events;
    // phase 的 observer 發生於 start 之前；不能把尚未啟動誤當 exec 故障。
    while (!(await deadline.run(() => container.inspect())).State.Running)
      await deadline.run(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
      );
    async function waitFile(file: string) {
      while (
        (await inside(container, `test -e /tmp/${file}`, deadline)).exitCode !==
        0
      )
        await deadline.run(
          () => new Promise((resolve) => setTimeout(resolve, 50)),
        );
    }
    const parseCounters = (text: string) =>
      Object.fromEntries(
        text
          .trim()
          .split("\n")
          .map((line) => {
            const [key, value] = line.split(/\s+/);
            return [key, Number(value)];
          }),
      );
    await waitFile("oom-ready");
    proof.readyAt = new Date().toISOString();
    const before = parseCounters(
      (await inside(container, "cat /tmp/oom-before", deadline)).output,
    );
    const limit = Number(
      (await inside(container, "cat /tmp/oom-limit", deadline)).output.trim(),
    );
    proof.before = before;
    proof.memoryMax = limit;
    expect(limit).toBe(64 * 1024 * 1024);
    const parentScore = Number(
      (await inside(container, "cat /tmp/oom-parent-score", deadline)).output.trim(),
    );
    const observerScore = Number(
      (await inside(container, "cat /proc/self/oom_score_adj", deadline)).output.trim(),
    );
    proof.parentScore = parentScore;
    proof.observerScore = observerScore;
    expect(parentScore).toBe(-1000);
    expect(observerScore).toBe(-1000);
    expect(
      (await inside(container, "touch /tmp/oom-trigger", deadline)).exitCode,
    ).toBe(0);
    await waitFile("oom-finished");
    const after = parseCounters(
      (await inside(container, "cat /tmp/oom-after", deadline)).output,
    );
    const childExit = Number(
      (
        await inside(container, "cat /tmp/oom-child-exit", deadline)
      ).output.trim(),
    );
    proof.after = after;
    proof.childExit = childExit;
    const childScore = Number(
      (await inside(container, "cat /tmp/oom-child-score", deadline)).output.trim(),
    );
    proof.childScore = childScore;
    expect(childScore).toBe(1000);
    expect(childExit).toBe(137);
    expect(after.oom_kill).toBeGreaterThan(before.oom_kill);
    let meta = await deadline.run(() => container.inspect());
    while (
      !meta.State.OOMKilled ||
      !events.some(
        (event) => event.id === container.id && event.action === "oom",
      )
    ) {
      await deadline.run(
        () => new Promise((resolve) => setTimeout(resolve, 50)),
      );
      meta = await deadline.run(() => container.inspect());
    }
    proof.confirmedAt = new Date().toISOString();
    proof.oomKilled = meta.State.OOMKilled;
    expect(meta.State.Running).toBe(true);
    expect(meta.State.OOMKilled).toBe(true);
    expect(
      (await inside(container, "touch /tmp/oom-release", deadline)).exitCode,
    ).toBe(0);
    return proof;
  } catch (error) {
    await container.remove({ force: true }).catch(() => {});
    throw error;
  } finally {
    deadline.close();
    (stream as Readable | undefined)?.destroy();
    console.info("受控 OOM 證據", JSON.stringify(proof));
  }
}

it("E07.timeout：真實工作階段逾時後回收容器和專用工作卷", async () => {
  const run = randomUUID();
  try {
    await expect(
      c.phase(
        run,
        worker,
        ["node", "-e", "setInterval(()=>{},1000)"],
        "none",
        undefined,
        1000,
      ),
    ).rejects.toThrow("時間限制");
    expect(
      await c.docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: [`io.agentflow.instance=${instance}`],
        }),
      }),
    ).toHaveLength(0);
  } finally {
    await c.dispose(run);
  }
  await expect(
    c.docker.getVolume(c.volume(run)).inspect(),
  ).rejects.toMatchObject({ statusCode: 404 });
}, 15000);

async function constrained(
  script: string,
  overrides: Record<string, unknown>,
  controlled = false,
) {
  const run = randomUUID(),
    container = await c.docker.createContainer({
      Image: worker,
      User: "1000:1000",
      Entrypoint: controlled ? ["sh", "-c", script] : ["node", "-e", script],
      Cmd: [],
      Labels: c.labels(run),
      HostConfig: {
        ...containerPolicy(c.volume(run), "none"),
        Binds: [],
        Memory: 64 * 1024 * 1024,
        MemorySwap: 64 * 1024 * 1024,
        ...(controlled ? { OomScoreAdj: -1000 } : {}),
        ...overrides,
      },
    });
  const timer = setTimeout(
    () => void container.remove({ force: true }).catch(() => {}),
    15000,
  );
  try {
    await container.start();
    const pressure = controlled ? await controlPressure(container) : undefined;
    const result = await container.wait();
    const deadline = new ContainerDeadline(
      3000,
      new AppError(503, "測試容器的退出狀態查詢逾時"),
    );
    const samples: Array<{
      elapsedMs: number;
      oomKilled: boolean;
      exitCode: number;
    }> = [];
    const started = Date.now();
    let meta;
    try {
      do {
        meta = await deadline.run(() => container.inspect());
        samples.push({
          elapsedMs: Date.now() - started,
          oomKilled: meta.State.OOMKilled,
          exitCode: meta.State.ExitCode,
        });
        if (
          result.StatusCode !== 137 ||
          meta.State.OOMKilled ||
          Date.now() - started >= 2000
        )
          break;
        await deadline.run(
          () => new Promise((resolve) => setTimeout(resolve, 100)),
        );
      } while (true);
    } finally {
      deadline.close();
    }
    const log = await container.logs({ stdout: true, stderr: true });
    return { result, meta, samples, pressure, output: log.toString() };
  } finally {
    clearTimeout(timer);
    await container.remove({ force: true }).catch(() => {});
  }
}
it("E07.oom：獨立 64 MiB 容器觸發真實 OOM，不消耗正式 2 GiB 上限", async () => {
  const result = await constrained(controlledOomScript, {}, true);
  expect(result.result.StatusCode).toBe(137);
  expect(
    result.meta.State.OOMKilled,
    `同一容器的狀態觀察：${JSON.stringify(result.samples)}`,
  ).toBe(true);
}, 25000);

it("E07.oom-diagnostic：真 phase 回報 OOM 的中文原因與 64 MiB 限制，原輸出仍保留", async () => {
  const run = randomUUID(),
    create = c.docker.createContainer.bind(c.docker);
  const spy = vi
    .spyOn(c.docker, "createContainer")
    .mockImplementation((options) =>
      create({
        ...options,
        HostConfig: {
          ...options.HostConfig,
          Memory: 64 * 1024 * 1024,
          MemorySwap: 64 * 1024 * 1024,
          OomScoreAdj: -1000,
        },
      }),
    );
  let pressure: Promise<unknown> | undefined;
  try {
    const result = await c.phase(
      run,
      worker,
      ["sh", "-c", controlledOomScript],
      "none",
      undefined,
      15000,
      false,
      false,
      (event) => {
        if (event.containerId) {
          pressure = controlPressure(c.docker.getContainer(event.containerId));
          void pressure.catch(() => {});
        }
      },
    );
    await pressure;
    expect(result.exitCode).toBe(137);
    expect(result.stdout).toContain("保留標準輸出");
    expect(result.stderr).toContain("保留錯誤輸出");
    expect(result.stderr).toContain("因記憶體不足（OOM）終止");
    expect(result.stderr).toContain("64 MiB");
  } finally {
    spy.mockRestore();
    await c.cancel(run);
  }
}, 20000);

it("E07.non-oom：真程序自行退出 137 不會被誤標為記憶體耗盡", async () => {
  const run = randomUUID();
  try {
    const result = await c.phase(
      run,
      worker,
      ["node", "-e", "console.error('合成自行退出');process.exit(137)"],
      "none",
      undefined,
      10000,
      false,
      false,
    );
    expect(result.exitCode).toBe(137);
    expect(result.stderr).toContain("合成自行退出");
    expect(result.stderr).toContain("未確認");
    expect(result.stderr).not.toContain("因記憶體不足（OOM）終止");
  } finally {
    await c.cancel(run);
  }
}, 20000);
it("E07.pids：獨立 16 PID 容器限制可觀察，拒絕再啟動程序後可回收", async () => {
  const result = await constrained(
    "const {spawn}=require('child_process');let failed=false;for(let i=0;i<32;i++){const c=spawn('sleep',['10']);c.on('error',e=>{if(e.code==='EAGAIN'){failed=true;console.log('PID_LIMIT_EAGAIN')}})}setTimeout(()=>process.exit(failed?0:1),500)",
    { PidsLimit: 16, Memory: 128 * 1024 * 1024, MemorySwap: 128 * 1024 * 1024 },
  );
  expect(result.result.StatusCode).toBe(0);
  expect(result.meta.HostConfig.PidsLimit).toBe(16);
  expect(result.output).toContain("PID_LIMIT_EAGAIN");
}, 25000);
it("E07.disk：只填滿獨立 8 MiB tmpfs，出現 ENOSPC 後清除，主機磁碟不被填滿", async () => {
  const result = await constrained(
    "const fs=require('fs');try{fs.writeFileSync('/tmp/fill',Buffer.alloc(16*1024*1024,1));process.exitCode=1}catch(e){console.log(e.code);if(e.code!=='ENOSPC')process.exitCode=2}",
    { Tmpfs: { "/tmp": "rw,nosuid,size=8m,mode=1777" } },
  );
  expect(result.result.StatusCode).toBe(0);
  expect(result.output).toContain("ENOSPC");
}, 25000);
