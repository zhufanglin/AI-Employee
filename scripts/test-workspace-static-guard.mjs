import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { denyWorkspaceStatic } = require('../packages/server/dist/common/workspace-static-guard.js');
const root = await mkdtemp(join(tmpdir(), 'fcm-static-guard-'));
let server;
try {
  await mkdir(join(root, 'workspace', 'demo'), { recursive: true });
  await mkdir(join(root, 'media'), { recursive: true });
  await writeFile(join(root, 'workspace', 'demo', 'private.txt'), 'private fixture');
  await writeFile(join(root, 'media', 'public.txt'), 'public fixture');
  const app = express();
  app.use('/uploads', denyWorkspaceStatic, express.static(root));
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/uploads/workspace/demo/private.txt', '/uploads/%77orkspace/demo/private.txt', '/uploads/workspace%2fdemo%2fprivate.txt', '/uploads/WORKSPACE/demo/private.txt', '/uploads/workspace%5cdemo%5cprivate.txt']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.notEqual(await response.text(), 'private fixture', path);
  }
  const publicResponse = await fetch(base + '/uploads/media/public.txt');
  assert.equal(publicResponse.status, 200);
  assert.equal(await publicResponse.text(), 'public fixture');
  console.log('Workspace static guard: anonymous and encoded paths blocked; public media remains accessible');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
