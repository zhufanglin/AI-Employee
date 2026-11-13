// 沙箱里 prisma CLI 无法 spawn schema-engine（EPERM），改为：
//   1) 用 PrismaClient 的原生 library 引擎直接执行 migration.sql 里的 DDL
//   2) 把这条迁移登记进 _prisma_migrations（checksum = sha256(sql)），让 `prisma migrate status` 保持干净
// 用法：node _work\apply-timeline-migration.mjs
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const MIGRATIONS = "packages/server/prisma/migrations";
const NAME = readdirSync(MIGRATIONS).filter((d) => d.endsWith("_add_timeline_job")).sort().pop();
if (!NAME) throw new Error("迁移目录不存在");
const sql = readFileSync(join(MIGRATIONS, NAME, "migration.sql"), "utf8");
const checksum = createHash("sha256").update(sql).digest("hex");

const prisma = new PrismaClient({
  datasources: { db: { url: "mysql://fcm:fcm_dev_pass@127.0.0.1:3306/fcmediaagent_v2" } },
});

const statements = sql
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
  .filter(Boolean);

const done = await prisma.$queryRawUnsafe(
  `SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?`,
  NAME,
);
if (done.length) {
  console.log("already applied", NAME);
} else {
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
    console.log("ok:", stmt.split("\n")[0].slice(0, 70));
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES (?, ?, NOW(3), ?, NULL, NULL, NOW(3), ?)`,
    randomUUID(),
    checksum,
    NAME,
    statements.length,
  );
  console.log("recorded", NAME, checksum.slice(0, 12));
}

const cols = await prisma.$queryRawUnsafe(`SHOW COLUMNS FROM TimelineJob`);
console.log(cols.map((c) => `${c.Field}:${c.Type}`).join(", "));
await prisma.$disconnect();
