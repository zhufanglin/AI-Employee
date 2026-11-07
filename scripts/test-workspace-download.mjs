import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { WorkspaceModule } = require('../packages/server/dist/workspace/workspace.module');
const { JwtAuthGuard } = require('../packages/server/dist/common/jwt-auth.guard');
const files = require('../packages/server/dist/capabilities/capabilities/files');
const root = await mkdtemp(join(tmpdir(), 'fcm-download-'));
process.env.WORKSPACE_DIR = root;
for (const name of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION', 'OSS_ENDPOINT']) process.env[name] = '';
class TestModule {}
Module({ imports: [WorkspaceModule] })(TestModule);
let app;
try {
  const jwt = new JwtService({ secret: 'local-fixture-secret' });
  app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalGuards(new JwtAuthGuard(jwt, new Reflector()));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const file = await files.saveWorkspaceFile('fixture-user-a', '客户资料.txt', Buffer.from('private fixture'));
  const url = base + '/workspace/download?key=' + encodeURIComponent(file.file.key);
  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 401);
  const token = (id) => jwt.sign({ sub: id });
  const other = await fetch(url, { headers: { authorization: 'Bearer ' + token('fixture-user-b') } });
  assert.equal(other.status, 400);
  const owner = await fetch(url, { headers: { authorization: 'Bearer ' + token('fixture-user-a') } });
  assert.equal(owner.status, 200);
  assert.equal(await owner.text(), 'private fixture');
  assert.match(owner.headers.get('content-disposition'), /^attachment;/);
  assert.match(owner.headers.get('cache-control'), /no-store/);
  console.log('Workspace download: anonymous and cross-user denied, owner download succeeds');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
