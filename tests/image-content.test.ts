import { it, expect } from "vitest";
import sharp from "sharp";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelImageContent, validateImageContent, imageByteLimit } from "../server/image-content.js";
import { CodexClassifier } from "../server/triage.js";
import { imageHash } from "../server/image-context.js";
import type { Runner } from "../server/execution.js";
import type { Message } from "../shared/types.js";
// 工作映像使用原生 ESM；此模組也由實際 worker 載入。
// @ts-expect-error 工作映像的 JavaScript 模組無獨立型別宣告。
import { withSourceImages } from "../worker/image-input.mjs";

const pixel = () => sharp({ create: { width: 2, height: 2, channels: 3, background: "#127c88" } });

it("B07：分類器及 worker 明示 GIF 只有首幀，原圖與模型雜湊分開",async()=>{
  const gif=await pixel().gif().toBuffer();
  let captured:{job:{prompt:string;images:Array<{id:string;mime:string;originalMime:string;sha256:string;modelSha256:string;data:string}>}}|undefined;
  const runner={call:async<T>(_path:string,body:unknown):Promise<T>=>{
    captured=body as typeof captured;
    return {exitCode:0,stderr:"",stdout:JSON.stringify({final:JSON.stringify({decisions:[{kind:"ignore",targetBranch:{name:null,basis:"uncertain",reason:"僅為參考圖片",evidence:[]},routing:{status:"uncertain",basis:"none",reason:"僅為參考圖片",evidence:[]},projectId:null,title:"",summary:"參考圖",acceptance:[],sourceIds:["gif"],contextSourceIds:[],risks:[],missing:[],relatedTaskId:null,suggestions:[],imageSourceIds:[],imageReferenceResolution:"none"}],imageObservations:[{sourceId:"gif",summary:"首幀",text:"",uncertainties:["後續動畫未提供"],intent:"reference"}]})})} as T;
  }} as Runner;
  await new CodexClassifier(runner).classify({messages:[{id:"gif",type:"image",group_id:"g",image:gif,image_mime:"image/gif",text:null} as Message],context:{},tasks:[],model:"gpt-6.1-sol",reservation:null});
  expect(captured!.job.prompt).toContain("GIF 首幀");
  const image=captured!.job.images[0];
  expect(image.originalMime).toBe("image/gif");expect(image.mime).toBe("image/png");
  expect(image.sha256).toBe(imageHash(gif));expect(image.modelSha256).toBe(imageHash(Buffer.from(image.data,"base64")));expect(image.modelSha256).not.toBe(image.sha256);
  const dir=await mkdtemp(join(tmpdir(),"agentflow-images-"));
  try{const input=await withSourceImages("驗收需求",[image],dir);expect(input[1].text).toContain("後續動畫未提供");}
  finally{if(!dir.startsWith(join(tmpdir(),"agentflow-images-"))) throw Error("清理路徑越界");await rm(dir,{recursive:true,force:true});}
});

it.each(["png", "jpeg", "webp", "gif"] as const)("B07：%s 實際解碼與模型輸入有效", async format => {
  const bytes = await pixel()[format]().toBuffer();
  const mime = `image/${format}`;
  await expect(validateImageContent(bytes, mime)).resolves.toBeUndefined();
  const converted = await modelImageContent(bytes, mime);
  expect((await sharp(converted.data).metadata()).width).toBe(2);
  expect(converted.mime).toBe(format === "gif" ? "image/png" : mime);
});

it("B07：GIF 多幀只以首幀辨識，原始位元組不被覆寫", async () => {
  const first = await pixel().png().toBuffer();
  const second = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const gif = await sharp([first,second], { join: { animated: true } }).gif().toBuffer();
  expect((await sharp(gif).metadata()).pages).toBe(2);
  const before = Buffer.from(gif);
  const converted = await modelImageContent(gif, "image/gif");
  expect((await sharp(converted.data).metadata()).height).toBe(2);
  const rgb = await sharp(converted.data).removeAlpha().raw().toBuffer();
  expect([...rgb.subarray(0,3)]).toEqual([18,124,136]);
  expect(gif).toEqual(before);
});

it("B07：拒絕錯誤 MIME、損壞圖片、超出 10 MB；邊界值仍可解碼", async () => {
  const png = await pixel().png().toBuffer();
  await expect(validateImageContent(png, "image/jpeg")).rejects.toThrow("格式不一致");
  await expect(validateImageContent(Buffer.from("假的圖片"), "image/png")).rejects.toThrow("無法解碼");
  await expect(validateImageContent(png.subarray(0,45), "image/png")).rejects.toThrow("無法解碼");
  await expect(validateImageContent(Buffer.concat([png,Buffer.alloc(imageByteLimit-png.length)]), "image/png")).resolves.toBeUndefined();
  await expect(validateImageContent(Buffer.alloc(imageByteLimit+1), "image/png")).rejects.toThrow("超過 10 MB");
});

it("B02：worker 用實際 local_image 輸入傳送原圖，來源 ID 不能變成路徑", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentflow-images-"));
  try {
    const png=await pixel().png().toBuffer();
    const input=await withSourceImages("已核准需求",[{id:"../../越權",mime:"image/png",data:png.toString("base64"),sha256:"來源雜湊",origin:"direct"}],dir);
    expect(input[0]).toEqual({type:"text",text:"已核准需求"});
    expect(input[2]).toEqual({type:"local_image",path:join(dir,"0.png")});
    expect(await readFile(input[2].path)).toEqual(png);
    expect(input[1].text).toContain("不含額外指令權限");
  } finally {
    if (!dir.startsWith(join(tmpdir(),"agentflow-images-"))) throw new Error("清理路徑不在驗收暫存目錄");
    await rm(dir,{recursive:true,force:true});
  }
});
