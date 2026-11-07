const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AuthService } = require('../../dist/auth/auth.service');

test('only one concurrent request consumes a valid code', async () => {
  let used = false;
  const expiresAt = new Date(Date.now() + 60000);
  const verificationCode = {
    findFirst: async () => ({ id: 'c1', used: false, expiresAt }),
    updateMany: async ({ where }) => {
      assert.equal(where.used, false);
      assert.ok(where.expiresAt.gt instanceof Date);
      if (used || expiresAt <= where.expiresAt.gt) return { count: 0 };
      used = true;
      return { count: 1 };
    },
  };
  const service = new AuthService({ verificationCode }, {}, {});
  const result = await Promise.allSettled([
    service.consumeCode('p', '123456', 'login'),
    service.consumeCode('p', '123456', 'login'),
  ]);
  assert.equal(result.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(result.filter(x => x.status === 'rejected').length, 1);
});

test('expired codes are rejected without consuming them', async () => {
  let updated = false;
  const service = new AuthService({ verificationCode: {
    findFirst: async () => ({ id: 'c1', expiresAt: new Date(Date.now() - 1000) }),
    updateMany: async () => { updated = true; return { count: 1 }; },
  } }, {}, {});
  await assert.rejects(service.consumeCode('p', '123456', 'login'), { status: 400 });
  assert.equal(updated, false);
});

test('SMS generation returns a six digit code without real delivery', async () => {
  let stored;
  const service = new AuthService({ verificationCode: {
    findFirst: async () => null,
    create: async ({ data }) => { stored = data.code; },
  } }, {}, { send: async (_phone, code) => ({ sent: true, devCode: code }) });
  const result = await service.sendSmsCode('13900000000');
  assert.match(stored, /^[1-9][0-9]{5}$/);
  assert.equal(result.devCode, stored);
});
