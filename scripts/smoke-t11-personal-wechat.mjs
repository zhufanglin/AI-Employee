// T-11 个人微信链路冒烟：登录 → /channels/personal-wechat/status（经生产的 SSH 反向隧道打到家里网桥）
// 用法（在服务器或任意能访问 API 的机器上）：
//   FCM_API=http://127.0.0.1:3000/api FCM_PHONE=13900139000 node scripts/smoke-t11-personal-wechat.mjs
const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const PHONE = process.env.FCM_PHONE || "13900139000";
// 出站自测会话（默认文件传输助手，避免打扰真实联系人）
const CHAT = process.env.FCM_CHAT || "文件传输助手";
const results = [];
const log = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log((ok ? "[PASS] " : "[FAIL] ") + name + (detail === undefined ? "" : " -> " + JSON.stringify(detail).slice(0, 300)));
};

async function call(path, init = {}) {
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}
const jpost = (path, data, token) => call(path, {
  method: "POST",
  headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
  body: JSON.stringify(data ?? {}),
});
const jget = (path, token) => call(path, { headers: token ? { authorization: "Bearer " + token } : {} });

async function login() {
  let sent = await jpost("/auth/sms/send", { phone: PHONE });
  if (sent.status === 429 || !sent.body?.devCode) {
    // 生产短信 60 秒频控：等一轮再试
    await new Promise((r) => setTimeout(r, 62000));
    sent = await jpost("/auth/sms/send", { phone: PHONE });
  }
  const code = sent.body?.devCode;
  if (!code) throw new Error("未拿到 devCode（手机号不在 DEV_SMS_ALLOWLIST？）：" + JSON.stringify(sent.body).slice(0, 200));
  const login = await jpost("/auth/sms/login", { phone: PHONE, code });
  const token = login.body?.accessToken || login.body?.token;
  if (!token) throw new Error("登录失败：" + JSON.stringify(login.body).slice(0, 200));
  return token;
}

try {
  const token = await login();
  log(true, "登录成功", { phone: PHONE });

  const unauth = await jget("/channels/personal-wechat/status");
  log(unauth.status === 401, "未带 JWT 访问 status 返回 401", { status: unauth.status });

  const status = await jget("/channels/personal-wechat/status", token);
  const body = status.body || {};
  const okShape = status.status === 200 && typeof body === "object" && "logged_in" in body;
  log(okShape, "带 JWT 访问 status 返回网桥状态", { status: status.status, body });

  const contacted = body.backend !== undefined || body.ok === true;
  log(contacted, "已连上家里网桥（返回体含后端/ok 字段）", { backend: body.backend, ok: body.ok });

  if (body.logged_in === true) {
    log(true, "微信已登录，昵称可见", { nickname: body.nickname, wxid: body.wxid, wechat_version: body.wechat_version });
  } else {
    log(false, "微信尚未登录（请用专用小号在 4.x 上登录并保持主窗口打开）", {
      wechat_version: body.wechat_version,
      hint: "登录后重跑本脚本；此时 logged_in 应为 true",
    });
  }

  // 出站真发 + 读回：证明「平台 → 隧道 → 网桥 → 微信」这一段真的能发出去
  const probe = "[T-11 出站自测] " + new Date().toISOString();
  const send = await jpost("/channels/personal-wechat/send", { name: CHAT, msg: probe }, token);
  // NestJS POST 默认 201，两者都算成功
  const sentOk = (send.status === 200 || send.status === 201) && (send.body?.ok === true || typeof send.body?.sent_at === "number");
  log(sentOk, "向微信会话发送测试消息（出站链路）", { status: send.status, body: send.body });

  await new Promise((r) => setTimeout(r, 2500));
  const back = await jget("/channels/personal-wechat/messages?chat_name=" + encodeURIComponent(CHAT), token);
  const items = Array.isArray(back.body?.items) ? back.body.items : [];
  const echoed = items.some((it) => String(it?.text ?? "").includes(probe));
  log(echoed, "消息已出现在该会话消息流中（读回校验）", { status: back.status, total: items.length, last: items[items.length - 1] });

  const failed = results.filter((r) => !r.ok).length;
  console.log("");
  console.log(failed === 0 ? "T11 PERSONAL WECHAT SMOKE OK (" + results.length + " checks)" : "T11 PERSONAL WECHAT SMOKE FAILED (" + failed + "/" + results.length + ")");
  process.exit(failed === 0 ? 0 : 1);
} catch (error) {
  console.error("[FATAL]", error && error.message ? error.message : error);
  process.exit(2);
}
