const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JwtService } = require('@nestjs/jwt');
const { ComputeAuthGuard } = require('../../dist/compute/compute-auth.guard');

test('compute authentication validates JWT signatures and expiry, and retains proxy token support', async () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const prisma = { user: { findUnique: async ({ where }) => where.id === 'u1' ? { id: 'u1', credits: 5, status: 'active' } : null } };
  const proxy = { validateProxyToken: async token => { if (token === 'rrclaw-proxy-valid') return 'u1'; throw Error('invalid'); } };
  const guard = new ComputeAuthGuard(jwt, prisma, proxy);
  const authenticate = async token => {
    const req = { headers: { authorization: 'Bearer ' + token } };
    const ok = await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) });
    assert.equal(ok, true);
    assert.equal(req.user.userId, 'u1');
  };
  await authenticate(jwt.sign({ sub: 'u1' }, { expiresIn: '1h' }));
  await assert.rejects(authenticate(new JwtService({ secret: 'forged' }).sign({ sub: 'u1' })), { status: 401 });
  await assert.rejects(authenticate(jwt.sign({ sub: 'u1' }, { expiresIn: -1 })), { status: 401 });
  await authenticate('rrclaw-proxy-valid');
  await assert.rejects(authenticate('rrclaw-proxy-bad'), { status: 401 });
});

