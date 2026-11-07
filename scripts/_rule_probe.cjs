const { BlockList } = require('node:net');
const ip = '103.235.46.96';
const rules = [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]];
console.log('node', process.version);
for (const [a,p] of rules) {
  const b = new BlockList(); b.addSubnet(a,p,'ipv4');
  console.log(a+'/'+p, b.check(ip,'ipv4'));
}
const b6 = new BlockList();
for (const [a,p] of [["::",96],["::ffff:0:0",96],["64:ff9b::",96],["64:ff9b:1::",48],["100::",64],["fc00::",7],["fe80::",10],["fec0::",10],["ff00::",8],["2001:db8::",32],["2001::",32],["2002::",16]]) b6.addSubnet(a,p,'ipv6');
console.log('mapped-as-v4 in ipv6 list?', b6.check(ip,'ipv4'));
console.log('8.8.8.8 fresh all-rules:', (()=>{const b=new BlockList();for(const [a,p] of rules)b.addSubnet(a,p,'ipv4');return b.check('8.8.8.8','ipv4');})());