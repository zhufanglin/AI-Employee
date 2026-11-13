import { spawn } from "node:child_process";
import fs from "node:fs";
const out = "C:/Users/30290/Desktop/fcmediaagent-replica/_work/probe-out.txt";
const fd = fs.openSync(out, "w");
const p = spawn("ffprobe", ["-v","error","-show_entries","format=duration","-of","csv=p=0","C:/Users/30290/Desktop/数字人/素材包/音频/新录音 17.m4a"], { stdio: ["ignore", fd, "ignore"] });
p.on("exit", (code) => { fs.closeSync(fd); console.log("exit", code, "->", fs.readFileSync(out,"utf8").trim()); });
