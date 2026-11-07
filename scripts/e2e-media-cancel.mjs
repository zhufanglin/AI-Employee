const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900000002";
const out = [];
const log = (ok, name, detail) => { out.push(ok); console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail === undefined ? "" : " -> " + JSON.stringify(detail).slice(0, 400))); };
async function call(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const jpost = (p, d, t) => call(p, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: "Bearer " + t } : {}) }, body: JSON.stringify(d ?? {}) });
const jget = (p, t) => call(p, { headers: t ? { authorization: "Bearer " + t } : {} });

(async () => {
  let sent = await jpost("/auth/sms/send", { phone: PHONE });
  if (!sent.body?.devCode) { await new Promise(r => setTimeout(r, 62000)); sent = await jpost("/auth/sms/send", { phone: PHONE }); }
  const code = sent.body?.devCode;
  if (!code) throw new Error("未拿到 devCode: " + JSON.stringify(sent.body).slice(0, 200));
  const login = await jpost("/auth/sms/login", { phone: PHONE, code });
  const token = login.body?.accessToken || login.body?.token;
  if (!token) throw new Error("登录失败: " + JSON.stringify(login.body).slice(0, 200));
  log(true, "登录成功", { phone: PHONE });

  const before = await jget("/credits/balance", token);
  const beforeBalance = Number(before.body?.balance ?? NaN);
  log(before.status === 200 && Number.isFinite(beforeBalance), "读取初始积分", { status: before.status, balance: before.body?.balance });

  const submit = await jpost("/media/images/generations", { prompt: "取消自检：一只橘猫坐在窗台上", size: 7 }, token);
  const taskId = submit.body?.taskId;
  log(submit.status < 300 && typeof taskId === "string" && taskId.length > 0, "提交文生图任务", { status: submit.status, taskId, estimatedAmount: submit.body?.estimatedAmount });
  if (!taskId) throw new Error("提交未返回 taskId: " + JSON.stringify(submit.body).slice(0, 300));
  const estimated = Number(submit.body?.estimatedAmount ?? NaN);

  const cancel = await jpost("/media/tasks/" + encodeURIComponent(taskId) + "/cancel", {}, token);
  const status = String(cancel.body?.status || "").toUpperCase();
  log(cancel.status < 300 && status === "CANCELLED", "取消任务返回 CANCELLED", { http: cancel.status, status: cancel.body?.status, settledAmount: cancel.body?.settledAmount });
  log(Number(cancel.body?.settledAmount) === 0, "取消后结算金额为 0", { settledAmount: cancel.body?.settledAmount });
  log(cancel.body?.resultMeta?.cancel?.ok === true || typeof cancel.body?.resultMeta?.cancel?.code === "number", "记录上游取消结果", cancel.body?.resultMeta?.cancel);

  const again = await jpost("/media/tasks/" + encodeURIComponent(taskId) + "/cancel", {}, token);
  log(again.status === 409, "重复取消返回 409", { http: again.status, body: again.body });

  const readback = await jget("/media/tasks/" + encodeURIComponent(taskId), token);
  log(String(readback.body?.status || "").toUpperCase() === "CANCELLED", "回查任务仍为 CANCELLED", { status: readback.body?.status });

  const after = await jget("/credits/balance", token);
  const afterBalance = Number(after.body?.balance ?? NaN);
  log(afterBalance === beforeBalance, "积分已全额退回（前后一致）", { before: beforeBalance, after: afterBalance, estimated });

  const failed = out.filter(x => !x).length;
  console.log("");
  if (failed) { console.log("MEDIA CANCEL E2E FAILED (" + failed + "/" + out.length + ")"); process.exit(1); }
  console.log("MEDIA CANCEL E2E OK (" + out.length + " checks) task=" + taskId);
})().catch(error => { console.log("E2E ERROR: " + (error?.stack || error)); process.exit(2); });
