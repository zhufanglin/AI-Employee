
import { createRequire } from "node:module";
const require = createRequire("C:/Users/30290/Desktop/fcmediaagent-replica/packages/server/package.json");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const rows = await p.composeVideo.findMany({ where: { status: "completed", videoUrl: null }, select: { id: true, resultUrl: true } });
for (const r of rows) { if (r.resultUrl) await p.composeVideo.update({ where: { id: r.id }, data: { videoUrl: r.resultUrl } }); }
console.log("backfilled", rows.length);
await p.$disconnect();
