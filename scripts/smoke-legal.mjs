// P45 合规基线冒烟：公开法律文本页（用户协议 / 隐私政策 / AI 生成标识说明）
// 覆盖：公开可访问（无鉴权）/ HTML 渲染 / JSON 结构化 / 404 / 文案与实现一致性
const BASE = process.env.FCM_API || "http://127.0.0.1:3000/api";
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  console.log((cond ? "PASS " : "FAIL ") + name, detail === undefined ? "" : JSON.stringify(detail));
};

// Windows 上 Node 22 的 keep-alive 连接若在 process.exit 时仍挂着，会在 libuv 退出阶段断言崩溃（0xC0000409）
// ⇒ 一律显式 connection: close，并且不用 process.exit，只设 exitCode
const REQ = { headers: { connection: "close" } };
const get = async (path) => {
  const r = await fetch(BASE + path, REQ);
  const text = await r.text();
  return { status: r.status, text, type: r.headers.get("content-type") || "" };
};
const getJson = async (path) => {
  const r = await fetch(BASE + path, REQ);
  let body;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};

try {
  // 1. 目录：版本号 + 三份文本
  const idx = await getJson("/legal");
  const keys = (idx.body?.docs || []).map((d) => d.key).sort();
  check("index: 公开可访问且含版本号", idx.status === 200 && typeof idx.body?.version === "string" && idx.body.version.length >= 8, { status: idx.status, version: idx.body?.version });
  check("index: 三份文本齐全", keys.join(",") === "aigc,privacy,terms", keys);

  // 2. HTML 页（微信/审核方直接打开）
  for (const [key, mustHave] of [
    ["terms", ["用户协议", "三、付费、积分与退款", "十、联系我们"]],
    ["privacy", ["隐私政策", "跨境", "第三方共享"]],
    ["aigc", ["AI 生成", "显式标识", "隐式标识"]],
  ]) {
    const r = await get("/legal/" + key);
    const html = r.text || "";
    const hits = mustHave.filter((s) => html.includes(s));
    check(
      "html: " + key + " 渲染且无鉴权",
      r.status === 200 && r.type.includes("text/html") && html.startsWith("<!doctype html"),
      { status: r.status, type: r.type, bytes: html.length },
    );
    check("html: " + key + " 关键条款在位", hits.length === mustHave.length, { need: mustHave, miss: mustHave.filter((s) => !html.includes(s)) });
  }

  // 3. JSON 结构化（客户端离线缓存用）
  const privacy = await getJson("/legal/privacy?format=json");
  check("json: privacy 结构完整", privacy.status === 200 && privacy.body?.key === "privacy" && Array.isArray(privacy.body?.sections) && privacy.body.sections.length >= 8, {
    status: privacy.status,
    sections: privacy.body?.sections?.length,
  });
  check("json: privacy 有版本与更新日期", typeof privacy.body?.version === "string" && /^\d{4}-\d{2}-\d{2}$/.test(privacy.body?.updatedAt || ""), {
    version: privacy.body?.version,
    updatedAt: privacy.body?.updatedAt,
  });

  // 4. 文案与实现一致（数据流向不能漏：模型/媒体/搜索/短信/存储/支付）
  const privacyJson = JSON.stringify(privacy.body || {});
  const providers = ["火山方舟", "RunningHub", "Tavily", "阿里云", "微信支付"];
  const missing = providers.filter((p) => !privacyJson.includes(p));
  check("privacy: 第三方处理方与实现一致", missing.length === 0, { miss: missing });

  // 5. 跨境与 AIGC 声明不能少（合规硬要求）
  check("privacy: 明示数据跨境", privacyJson.includes("境外") && privacyJson.includes("第三十九条"), {});
  check("privacy: 引到 AIGC 标识办法", privacyJson.includes("人工智能生成合成内容标识办法"), {});

  // 6. 不存在的文本 404
  const nf = await get("/legal/not-exists");
  check("404: 未知文本", nf.status === 404, { status: nf.status });

  // 7. 不暴露内部路径/密钥之类
  const leaked = ["DATABASE_URL", "WECHAT_PAY_", "/opt/fcmediaagent"].filter((s) => (privacy.text || "").includes(s));
  check("privacy: 无内部信息泄露", leaked.length === 0, { leaked });
} catch (e) {
  check("exception", false, String(e && e.message ? e.message : e));
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (failed.length === 0 ? "LEGAL SMOKE OK" : "LEGAL SMOKE FAILED") + " (" + results.length + " checks, " + failed.length + " failed)");
process.exitCode = failed.length === 0 ? 0 : 1;
