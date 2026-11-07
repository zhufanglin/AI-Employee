const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const guard = require(path.join(__dirname, '..', '..', '..', 'dist', 'capabilities', 'capabilities', 'web-extract.js'));
const { isDenied, pickPublicAddress } = guard;

test('公网 IPv4 不应被判为内网（回归：::ffff:0:0/96 曾把全部 IPv4 拦掉）', () => {
  for (const address of ['103.235.46.96', '104.20.23.154', '203.205.232.110', '43.174.196.235', '8.8.8.8']) {
    assert.equal(isDenied(address, 4), false, address + ' 被误判为内网');
  }
});

test('内网 / 保留 IPv4 必须被拦', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '198.18.0.7', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isDenied(address, 4), true, address + ' 未被拦截');
  }
});

test('IPv4-mapped IPv6 按内嵌 IPv4 判定', () => {
  assert.equal(isDenied('::ffff:103.235.46.96', 6), false);
  assert.equal(isDenied('::ffff:127.0.0.1', 6), true);
  assert.equal(isDenied('::ffff:198.18.0.7', 6), true);
  assert.equal(isDenied('::ffff:7f00:1', 6), true);
  assert.equal(isDenied('::ffff:a9fe:a9fe', 6), true);
  assert.equal(isDenied('0:0:0:0:0:ffff:7f00:1', 6), true);
  assert.equal(isDenied('::ffff:67eb:2e60', 6), false);
});

test('IPv6 内网 / 保留段必须被拦，公网 IPv6 放行', () => {
  for (const address of ['::1', 'fc00::1', 'fe80::1', '64:ff9b::1.2.3.4', '2001:db8::1', '2002::1']) {
    assert.equal(isDenied(address, 6), true, address + ' 未被拦截');
  }
  assert.equal(isDenied('2606:4700:10::6814:179a', 6), false);
  assert.equal(isDenied('240d:c040:1:40::11d', 6), false);
});

test('pickPublicAddress 过滤内网并优先 IPv4', () => {
  const chosen = pickPublicAddress([
    { address: '2606:4700:10::6814:179a', family: 6 },
    { address: '104.20.23.154', family: 4 },
  ]);
  assert.equal(chosen.address, '104.20.23.154');

  assert.throws(() => pickPublicAddress([{ address: '127.0.0.1', family: 4 }, { address: '10.0.0.5', family: 4 }]), /禁止访问内网或保留地址/);
});
