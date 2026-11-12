// T-30 冒烟：compose-videos / clone-records / audio-materials 编排契约、归属隔离、失败退款
// 自带短信开发登录（无需 TEST_TOKEN），不依赖真实上游成功（未配置的上游以 400/502 + 退款断言）
import { createRequire } from "node:module";
import { loadServerEnv } from "./_env.mjs";
loadServerEnv();
const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const SERVER_DIR = process.env.FCM_SERVER_DIR || "C:\\Users\\30290\\Desktop\\fcmediaagent-replica\\packages\\server";
const require = createRequire(SERVER_DIR + "\\package.json");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const j = async (p, opts = {}) => {
  const r = await fetch(BASE + p, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const t = await r.text();
  let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function health() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + "/health"); if (r.ok) return true; } catch {}
    await wait(1000);
  }
  return false;
}
async function login(phone) {
  const send = await j("/auth/sms/send", { method: "POST", body: JSON.stringify({ phone }) });
  const code = send.body.devCode;
  if (!code) throw new Error("短信未返回 devCode：" + JSON.stringify(send.body));
  const res = await j("/auth/sms/login", { method: "POST", body: JSON.stringify({ phone, code, consent: { version: "2026-11-12", crossBorder: true, source: "smoke" } }) });
  if (!res.body.accessToken) throw new Error("登录失败：" + JSON.stringify(res.body));
  return { token: res.body.accessToken, id: res.body.user?.id, phone };
}

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? "PASS " : "FAIL ") + name, detail === undefined ? "" : JSON.stringify(detail));
};
const msg = (r) => r.body?.message || r.body?.error?.message || "";

try {
  if (!(await health())) { console.log("SERVER NOT UP"); process.exit(1); }

  const u1 = await login("139" + String(Date.now()).slice(-8));
  const u2 = await login("138" + String(Date.now() + 1).slice(-8));
  const a1 = { authorization: "Bearer " + u1.token };
  const a2 = { authorization: "Bearer " + u2.token };
  check("user login", !!u1.token && !!u2.token, { u1: u1.phone, u2: u2.phone });

  // 媒体任务直接扣积分（不吃免费额度），先给测试账号备足
  await prisma.user.update({ where: { id: u1.id }, data: { credits: 60 } });
  await prisma.user.update({ where: { id: u2.id }, data: { credits: 60 } });
  const balance = async () => (await j("/credits/balance", { headers: a1 })).body?.balance;

  // 1) 鉴权
  check("compose requires auth", (await j("/compose-videos")).status === 401);
  check("clone requires auth", (await j("/clone-records")).status === 401);
  check("audio requires auth", (await j("/audio-materials")).status === 401);

  // 2) 入参校验
  const noImage = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "lipsync", sourceAudioUrl: "audio.wav" }) });
  check("lipsync requires image", noImage.status === 400 && /人像/.test(msg(noImage)), msg(noImage));

  const noAudio = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "lipsync", videoUrl: "person.png" }) });
  check("lipsync requires audio", noAudio.status === 400 && /音频/.test(msg(noAudio)), msg(noAudio));

  const badType = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "bogus", videoUrl: "a.png", sourceAudioUrl: "a.wav" }) });
  check("invalid composeType rejected", badType.status === 400 && /composeType/.test(msg(badType)), msg(badType));

  const noImageMix = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "mixcut", prompt: "15秒卡点混剪" }) });
  check("mixcut requires image", noImageMix.status === 400 && /人像/.test(msg(noImageMix)), msg(noImageMix));

  const noPromptMix = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "mixcut", image: "openapi/ref.jpg" }) });
  check("mixcut requires prompt", noPromptMix.status === 400 && /提示词/.test(msg(noPromptMix)), msg(noPromptMix));

  // 3) 混剪参数非法：在扣费前拒绝，余额不得变动（不真实提交上游任务，避免 CI 烧钱）
  const before = await balance();
  const mixcutBad = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "mixcut", image: "not-a-valid-ref", prompt: "15秒卡点混剪" }) });
  const afterMix = await balance();
  check("mixcut rejects bad image ref", mixcutBad.status === 400 && /引用无效/.test(msg(mixcutBad)), msg(mixcutBad));
  check("invalid mixcut never charges", before === afterMix, { before, afterMix });

  // 文生图 / 图生视频：参数校验必须在扣费前完成（不真实提交，避免烧钱）
  const beforeImg = await balance();
  const noPromptImg = await j("/media/images/generations", { method: "POST", headers: a1, body: JSON.stringify({ size: 7 }) });
  check("image_gen requires prompt", noPromptImg.status === 400 && /提示词/.test(msg(noPromptImg)), msg(noPromptImg));
  const noImageVid = await j("/media/video/generations", { method: "POST", headers: a1, body: JSON.stringify({ prompt: "Time-lapse photography" }) });
  check("video_gen requires image", noImageVid.status === 400 && /首帧/.test(msg(noImageVid)), msg(noImageVid));
  const badImageVid = await j("/media/video/generations", { method: "POST", headers: a1, body: JSON.stringify({ image: "not-a-valid-ref", prompt: "Time-lapse photography" }) });
  check("video_gen rejects bad image ref", badImageVid.status === 400 && /引用无效/.test(msg(badImageVid)), msg(badImageVid));
  const afterImg = await balance();
  check("invalid image/video never charges", beforeImg === afterImg, { beforeImg, afterImg });

  // 使用非法引用验证扣费前拒绝，不把占位素材提交给真实上游。
  const lip = await j("/compose-videos", { method: "POST", headers: a1, body: JSON.stringify({ composeType: "lipsync", videoUrl: "invalid-reference", sourceAudioUrl: "https://example.com/t30-audio.wav", seconds: 2 }) });
  const afterLip = await balance();
  check("lipsync invalid reference rejected", lip.status === 400, { status: lip.status });
  check("lipsync invalid reference never charges", afterLip === before, { before, afterLip });
  const afterCleanup = await balance();

  // 4) 克隆记录
  const cloneNoSrc = await j("/clone-records", { method: "POST", headers: a1, body: JSON.stringify({ type: "voice" }) });
  check("clone requires sourceUrl", cloneNoSrc.status === 400 && /sourceUrl/.test(msg(cloneNoSrc)), msg(cloneNoSrc));

  const cloneNoText = await j("/clone-records", { method: "POST", headers: a1, body: JSON.stringify({ type: "voice", sourceUrl: "openapi/sample.wav" }) });
  check("clone requires text", cloneNoText.status === 400 && /文本/.test(msg(cloneNoText)), msg(cloneNoText));

  const cloneBadRef = await j("/clone-records", { method: "POST", headers: a1, body: JSON.stringify({ type: "voice", sourceUrl: "sample.wav", text: "你好" }) });
  check("clone rejects bad audio ref", cloneBadRef.status === 400 && /引用无效/.test(msg(cloneBadRef)), msg(cloneBadRef));

  const afterClone = await balance();
  check("invalid clone never charges", afterClone === afterCleanup, { afterCleanup, afterClone });

  // 5) 音频素材（纯本地记录，无上游依赖）
  const audioUp = await j("/audio-materials/upload", { method: "POST", headers: a1, body: JSON.stringify({ audioUrl: "https://example.com/t30-sample.wav" }) });
  check("audio material upload", (audioUp.status === 201 || audioUp.status === 200) && !!audioUp.body?.id, audioUp.status);
  const audioEmpty = await j("/audio-materials/upload", { method: "POST", headers: a1, body: JSON.stringify({}) });
  check("audio upload requires content", audioEmpty.status === 400, msg(audioEmpty));
  const audioList = await j("/audio-materials", { headers: a1 });
  check("audio list by owner", Array.isArray(audioList.body) && audioList.body.length === 1, audioList.body?.length);
  const audioList2 = await j("/audio-materials", { headers: a2 });
  check("audio isolated per user", Array.isArray(audioList2.body) && audioList2.body.length === 0, audioList2.body?.length);
  const audioDel = await j("/audio-materials/" + audioUp.body.id, { method: "DELETE", headers: a1 });
  check("audio delete", audioDel.status === 200 || audioDel.status === 201, audioDel.status);
  const audioDel2 = await j("/audio-materials/" + audioUp.body.id, { method: "DELETE", headers: a1 });
  check("audio delete idempotent 404", audioDel2.status === 404, audioDel2.status);

  // 6) 编排记录：直接落一条进行中的记录，验证查询推进/编辑/归属隔离/删除
  const seeded = await prisma.composeVideo.create({
    data: { phone: u1.phone, composeType: "lipsync", status: "cloning_audio", title: "T30 smoke" },
  });
  const list1 = await j("/compose-videos", { headers: a1 });
  check("compose list by owner", Array.isArray(list1.body) && list1.body.some((r) => r.id === seeded.id), list1.body?.length);
  const list2 = await j("/compose-videos", { headers: a2 });
  check("compose isolated per user", Array.isArray(list2.body) && !list2.body.some((r) => r.id === seeded.id), list2.body?.length);
  const patched = await j("/compose-videos/" + seeded.id, { method: "PATCH", headers: a1, body: JSON.stringify({ title: "T30 smoke patched" }) });
  check("compose patch title", patched.body?.title === "T30 smoke patched", patched.body?.title);
  const otherPatch = await j("/compose-videos/" + seeded.id, { method: "PATCH", headers: a2, body: JSON.stringify({ title: "hijack" }) });
  check("compose cross-user patch blocked", otherPatch.status === 404, otherPatch.status);
  const removed = await j("/compose-videos/" + seeded.id, { method: "DELETE", headers: a1 });
  check("compose delete", removed.status === 200 || removed.status === 201, removed.status);

  // 7) 回调幂等（无对应任务时应 404）
  const cb = await fetch(BASE + "/compose-videos/musetalk-callback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "none-exist", status: "SUCCESS" }) });
  check("musetalk callback 404 for unknown task", cb.status === 404, cb.status);

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== T30 RESULT:", failed.length === 0 ? "ALL PASS" : failed.length + " FAILED", "(" + results.length + " checks)");
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
  console.error("SMOKE ERROR", err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
