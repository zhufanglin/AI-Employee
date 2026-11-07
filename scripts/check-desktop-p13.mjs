#!/usr/bin/env node
/** 桌面端 0.1.3 冒烟：启动已安装客户端，用 CDP 断言版本与工作区 IPC 已暴露。 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const exe = path.join(os.homedir(), "AppData", "Local", "Programs", "fcmediaagent-desktop", "中科元晟 AI员工.exe");
if (!existsSync(exe)) { console.error("未找到已安装客户端：" + exe); process.exit(1); }
const port = 9223;
const child = spawn(exe, ["--remote-debugging-port=" + port], { detached: false, stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list");
  return res.json();
}

async function evaluate(ws, expression, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP 超时")), 15000);
    const onMessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(payload.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

let pass = 0;
function ok(name, detail) { pass += 1; console.log("[PASS] " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { console.log("[FAIL] " + name + " :: " + detail); process.exitCode = 1; }

try {
  let list = [];
  for (let i = 0; i < 40; i += 1) {
    try { list = await targets(); } catch { /* 还没起来 */ }
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page) break;
    await sleep(500);
  }
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没等到页面 target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  const info = await evaluate(ws, "window.fcm.info().then(v => JSON.stringify(v))", 1);
  const infoValue = JSON.parse(info.result.value);
  if (String(infoValue.version).startsWith("0.1.3")) ok("客户端版本 0.1.3", infoValue.version); else bad("客户端版本 0.1.3", infoValue.version);

  const ipc = await evaluate(ws, "JSON.stringify({ pick: typeof window.fcm.workspace.pick, list: typeof window.fcm.workspace.list, remove: typeof window.fcm.workspace.remove })", 2);
  const kinds = JSON.parse(ipc.result.value);
  if (kinds.pick === "function" && kinds.list === "function" && kinds.remove === "function") ok("工作区 IPC 已暴露", JSON.stringify(kinds));
  else bad("工作区 IPC 已暴露", JSON.stringify(kinds));

  // React 首帧可能还没渲染完，先轮询到正文非空再断言。
  let text = "";
  for (let i = 0; i < 30; i += 1) {
    const probe = await evaluate(ws, "(document.body && document.body.textContent || '').replace(/\\s+/g, ' ').slice(0, 400)", 3 + i);
    text = (probe && probe.result && probe.result.value) || "";
    if (text.length > 40) break;
    await sleep(500);
  }
  if (text.includes("员工办公区") || text.includes("登录") || text.includes("发送")) ok("渲染层已加载", text.slice(0, 40));
  else bad("渲染层已加载", text.slice(0, 80));
  ws.close();
} catch (error) {
  bad("冒烟执行", error && error.message ? error.message : String(error));
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(800);
  if (process.exitCode) console.log("DESKTOP 0.1.3 SMOKE FAILED (" + pass + " checks passed)");
  else console.log("DESKTOP 0.1.3 SMOKE OK (" + pass + " checks)");
}