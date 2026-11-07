const { BlockList } = require('node:net');
const ip = '103.235.46.96';
const v6 = [["::",96],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["fc00::",7],["fe80::",10],["fec0::",10],["ff00::",8],["2001:db8::",32],["2001::",32],["2002::",16]];
for (const [a,p] of v6) {
  const b = new BlockList(); b.addSubnet(a,p,'ipv6');
  console.log(a+'/'+p, 'check(ipv4)=', b.check(ip,'ipv4'), 'check(::ffff:mapped)=', b.check('::ffff:'+ip,'ipv6'));
}