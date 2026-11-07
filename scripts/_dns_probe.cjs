const d = require('dns').promises;
(async () => {
  for (const h of ['www.baidu.com','example.com','mp.weixin.qq.com','www.runninghub.ai']) {
    try { console.log(h, JSON.stringify(await d.lookup(h, { all: true, verbatim: true }))); }
    catch (e) { console.log(h, 'ERR', e.code); }
  }
})();