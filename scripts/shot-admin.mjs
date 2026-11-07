import { spawn } from "node:child_process";
import fs from "node:fs";

const BASE = "http://127.0.0.1:3000";
const OUT = "C:\\Users\\30290\\Desktop\\fcmediaagent-replica";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(BASE + "/api/auth/admin/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
}).then((r) => r.json());
if (!login.accessToken) { console.log("LOGIN FAILED", JSON.stringify(login)); process.exit(1); }

const candidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
const bin = candidates.find((p) => fs.existsSync(p));
if (!bin) { console.log("NO BROWSER"); process.exit(1); }
console.log("browser:", bin);

const udd = OUT + "\\_edgetmp";
const port = 9223;
const proc = spawn(bin, [
  "--headless=new", "--remote-debugging-port=" + port, "--user-data-dir=" + udd,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--window-size=1440,900", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });

let version = null;
for (let i = 0; i < 40; i++) {
  try { version = await fetch("http://127.0.0.1:" + port + "/json/version").then((r) => r.json()); break; } catch { await wait(300); }
}
if (!version) { console.log("CDP NOT READY"); proc.kill(); process.exit(1); }

const tab = await fetch("http://127.0.0.1:" + port + "/json/new?about:blank", { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0;
const pending = new Map();
const logs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
  if (msg.method === "Runtime.exceptionThrown") logs.push("EXCEPTION: " + JSON.stringify(msg.params.exceptionDetails?.text || msg.params));
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") logs.push("CONSOLE: " + msg.params.args.map((a) => a.value ?? a.description).join(" "));
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Runtime.enable");
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(OUT + "\\_admin_" + name + ".png", Buffer.from(data, "base64"));
  console.log("shot:", name);
};
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send("Page.navigate", { url: BASE + "/admin/" });
await wait(1200);
await evaluate("localStorage.setItem('fcm_admin_token', " + JSON.stringify(login.accessToken) + ")");
await send("Page.navigate", { url: BASE + "/admin/" });
await wait(2500);
console.log("TEXT1:", String(await evaluate("document.body.innerText")).replace(/\s+/g, " ").slice(0, 300));
await shot("overview");

for (const [tab, file] of [["orders", "orders"], ["users", "users"], ["employees", "employees"], ["pricing", "pricing"], ["site", "site"]]) {
  await evaluate('document.querySelector(\'[data-tab="' + tab + '"]\').click()');
  await wait(1600);
  const t = await evaluate("document.querySelector('.main')?.innerText || ''");
  console.log("TAB " + tab + ": " + String(t).replace(/\s+/g, " ").slice(0, 160));
  await shot(file);
}

console.log("ERRORS:", logs.length ? logs.join(" | ").slice(0, 800) : "none");
try { await send("Browser.close"); } catch {}
proc.kill();
await wait(300);
process.exit(0);
