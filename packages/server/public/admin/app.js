/* 中科元晟 · 运营后台（零构建，单文件 SPA） */
const API = location.origin + '/api';
const TOKEN_KEY = 'fcm_admin_token';
const state = { token: localStorage.getItem(TOKEN_KEY) || '', tab: 'overview', page: 1, q: '', status: '' };
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2);
const dt = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');

function toast(msg, type = '') {
  let box = $('.toast');
  if (!box) { box = document.createElement('div'); box.className = 'toast'; document.body.appendChild(box); }
  const el = document.createElement('div');
  if (type) el.className = type;
  el.textContent = String(msg).slice(0, 400);
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  const res = await fetch(API + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { logout(); throw new Error('登录已过期，请重新登录'); }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || (body.error && body.error.message))) || text || ('HTTP ' + res.status);
    throw new Error(Array.isArray(msg) ? msg.join('；') : msg);
  }
  return body;
}

function logout() { state.token = ''; localStorage.removeItem(TOKEN_KEY); render(); }

const NAV = [['overview','概览'],['orders','订单'],['users','用户'],['packages','积分套餐'],['codes','兑换码'],['employees','AI 员工'],['pricing','模型与媒体定价'],['site','站点配置']];
const STATUS_LABEL = { pending: '待支付', paid: '已支付', expired: '已过期', amount_mismatch: '金额异常', closed: '已关闭' };
const TAG = (s) => ({ paid: 'ok', pending: 'warn', amount_mismatch: 'bad', expired: 'bad', closed: '' }[s] || '');

function shell(inner) {
  const nav = NAV.map(([k, label]) => '<button data-tab="' + k + '" class="' + (state.tab === k ? 'active' : '') + '">' + label + '</button>').join('');
  return '<div class="layout"><aside class="side"><div class="brand">中科元晟 · 运营后台<small>AI员工 v0.1.0</small></div>'
    + '<nav class="nav">' + nav + '</nav>'
    + '<div class="foot"><button class="sm" data-act="refresh">刷新当前页</button><button class="sm danger" data-act="logout">退出登录</button></div>'
    + '</aside><main class="main">' + inner + '</main></div>';
}

function bindShell() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; state.page = 1; state.q = ''; state.status = ''; render(); });
  const r = $('[data-act="refresh"]'); if (r) r.onclick = render;
  const l = $('[data-act="logout"]'); if (l) l.onclick = logout;
}

const VIEWS = { overview: viewOverview, orders: viewOrders, users: viewUsers, packages: viewPackages, codes: viewCodes, employees: viewEmployees, pricing: viewPricing, site: viewSite };
const BINDS = { overview: bindOverview, orders: bindOrders, users: bindUsers, packages: bindPackages, codes: bindCodes, employees: bindEmployees, pricing: bindPricing, site: bindSite };

async function render() {
  const app = $('#app');
  if (!state.token) return renderLogin(app);
  app.innerHTML = shell('<div class="boot">加载中…</div>');
  bindShell();
  try {
    $('.main').innerHTML = await VIEWS[state.tab]();
    await BINDS[state.tab]();
  } catch (e) {
    $('.main').innerHTML = '<div class="panel"><b>加载失败</b><p class="muted">' + esc(e.message) + '</p></div>';
  }
}

function renderLogin(app) {
  app.innerHTML = '<div class="login"><h1>中科元晟 · 运营后台</h1><p>管理员账号登录（ADMIN_USERNAME / ADMIN_PASSWORD）</p>'
    + '<div class="field"><label>用户名</label><input id="lg-user" value="admin" /></div>'
    + '<div class="field"><label>密码</label><input id="lg-pass" type="password" /></div>'
    + '<button class="primary" id="lg-go" style="width:100%">登录</button></div>';
  const go = async () => {
    try {
      const r = await api('/auth/admin/login', { method: 'POST', body: JSON.stringify({ username: $('#lg-user').value.trim(), password: $('#lg-pass').value }) });
      state.token = r.accessToken || r.token;
      localStorage.setItem(TOKEN_KEY, state.token);
      toast('登录成功', 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#lg-go').onclick = go;
  $('#lg-pass').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

function pager(r) {
  if (!r || !r.totalPages || r.totalPages <= 1) return '';
  return '<div class="pager"><button class="sm" data-page="prev" ' + (r.page <= 1 ? 'disabled' : '') + '>上一页</button>'
    + '<span>第 ' + r.page + ' / ' + r.totalPages + ' 页</span>'
    + '<button class="sm" data-page="next" ' + (r.page >= r.totalPages ? 'disabled' : '') + '>下一页</button></div>';
}
function bindPager() {
  document.querySelectorAll('[data-page]').forEach((b) => b.onclick = () => {
    state.page = b.dataset.page === 'next' ? state.page + 1 : Math.max(1, state.page - 1);
    render();
  });
}

/* ---------- 概览 ---------- */
async function viewOverview() {
  const o = await api('/admin/overview');
  const u = await api('/admin/usage/summary').catch(() => null);
  const cards = [['用户总数', o.users], ['今日新增', o.todayNewUsers], ['已支付订单', o.paidOrders], ['待支付订单', o.pendingOrders],
    ['累计营收', '¥' + yuan(o.revenueTotal)], ['今日营收', '¥' + yuan(o.todayRevenue)],
    ['累计售出积分', o.creditsSold], ['今日 AI 调用', o.todayAiCalls], ['今日消耗积分', o.todayCreditsConsumed]]
    .map(([k, v]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + esc(v) + '</div></div>').join('');
  const models = ((u && u.modelBreakdown) || []).map((m) => '<tr><td class="mono">' + esc(m.modelId) + '</td><td class="right">' + m.requests + '</td><td class="right">' + m.totalTokens + '</td><td class="right">' + m.creditsCharged + '</td></tr>').join('');
  return '<h2>运营概览</h2><p class="sub">数据来自 /api/admin/overview 与 /api/admin/usage/summary</p>'
    + '<div class="cards">' + cards + '</div>'
    + '<div class="panel"><h2 style="font-size:15px">模型用量</h2><p class="sub">总计 ' + (u ? u.totalRequests : 0) + ' 次 / ' + (u ? u.totalTokens : 0) + ' tokens / 扣费 ' + (u ? u.totalCreditsCharged : 0) + ' 积分</p>'
    + '<table><thead><tr><th>模型</th><th class="right">调用</th><th class="right">Tokens</th><th class="right">扣积分</th></tr></thead><tbody>'
    + (models || '<tr><td colspan="4" class="empty">暂无数据</td></tr>') + '</tbody></table></div>';
}
async function bindOverview() {}

/* ---------- 订单 ---------- */
async function viewOrders() {
  const p = new URLSearchParams({ page: state.page, limit: 20 });
  if (state.q) p.set('keyword', state.q);
  if (state.status) p.set('status', state.status);
  const r = await api('/admin/orders?' + p);
  const rows = (r.items || []).map((o) => '<tr><td class="mono">' + esc(o.orderNo) + '</td>'
    + '<td class="mono">' + esc((o.user && (o.user.phone || o.user.nickname)) || o.userId) + '</td>'
    + '<td>' + esc((o.package && o.package.name) || o.packageId || '') + '</td>'
    + '<td class="right">¥' + yuan(o.amount) + '</td><td class="right">' + o.credits + '</td>'
    + '<td><span class="tag ' + TAG(o.status) + '">' + (STATUS_LABEL[o.status] || esc(o.status)) + '</span></td>'
    + '<td>' + dt(o.createdAt) + '</td>'
    + '<td class="right">' + (o.status === 'pending' ? '<button class="sm primary" data-confirm="' + esc(o.orderNo) + '">确认收款</button>' : (o.adminNote ? '<span class="muted">' + esc(o.adminNote) + '</span>' : '')) + '</td></tr>').join('');
  return '<h2>订单</h2><p class="sub">共 ' + r.total + ' 条 · 第 ' + r.page + '/' + r.totalPages + ' 页</p>'
    + '<div class="panel"><div class="toolbar">'
    + '<select id="od-status"><option value="">全部状态</option>' + Object.entries(STATUS_LABEL).map(([k, v]) => '<option value="' + k + '" ' + (state.status === k ? 'selected' : '') + '>' + v + '</option>').join('') + '</select>'
    + '<input id="od-q" placeholder="订单号 / 手机号 / 微信交易号" value="' + esc(state.q) + '" /><button id="od-search">查询</button></div>'
    + '<table><thead><tr><th>订单号</th><th>用户</th><th>套餐</th><th class="right">金额</th><th class="right">积分</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="8" class="empty">暂无订单</td></tr>') + '</tbody></table>' + pager(r) + '</div>';
}
async function bindOrders() {
  $('#od-search').onclick = () => { state.q = $('#od-q').value.trim(); state.status = $('#od-status').value; state.page = 1; render(); };
  document.querySelectorAll('[data-confirm]').forEach((b) => b.onclick = async () => {
    if (!confirm('确认已收到该订单款项？将立即给用户加积分。')) return;
    try { await api('/admin/orders/' + encodeURIComponent(b.dataset.confirm) + '/confirm', { method: 'POST', body: '{}' }); toast('已确认收款', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  bindPager();
}

/* ---------- 用户 ---------- */
async function viewUsers() {
  const p = new URLSearchParams({ page: state.page, limit: 20 });
  if (state.q) p.set('keyword', state.q);
  const r = await api('/admin/users?' + p);
  const rows = (r.items || []).map((u) => '<tr><td class="mono">' + esc(u.phone || u.email || u.id) + '</td><td>' + esc(u.nickname || '') + '</td>'
    + '<td>' + esc(u.role) + '</td><td><span class="tag ' + (u.status === 'active' ? 'ok' : 'bad') + '">' + (u.status === 'active' ? '正常' : '禁用') + '</span></td>'
    + '<td class="right">' + u.credits + '</td><td>' + dt(u.createdAt) + '</td>'
    + '<td class="right"><button class="sm" data-credits="' + esc(u.id) + '">调积分</button>'
    + '<button class="sm" data-status="' + esc(u.id) + '" data-cur="' + esc(u.status) + '">' + (u.status === 'active' ? '禁用' : '启用') + '</button>'
    + '<button class="sm" data-pass="' + esc(u.id) + '">重置密码</button></td></tr>').join('');
  return '<h2>用户</h2><p class="sub">共 ' + r.total + ' 人 · 第 ' + r.page + '/' + r.totalPages + ' 页</p>'
    + '<div class="panel"><div class="toolbar"><input id="us-q" placeholder="手机号 / 昵称 / 邮箱" value="' + esc(state.q) + '" /><button id="us-search">查询</button></div>'
    + '<table><thead><tr><th>账号</th><th>昵称</th><th>角色</th><th>状态</th><th class="right">积分</th><th>注册时间</th><th></th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="7" class="empty">暂无用户</td></tr>') + '</tbody></table>' + pager(r) + '</div>';
}
async function bindUsers() {
  $('#us-search').onclick = () => { state.q = $('#us-q').value.trim(); state.page = 1; render(); };
  document.querySelectorAll('[data-credits]').forEach((b) => b.onclick = async () => {
    const raw = prompt('输入调整数量（正数=赠送，负数=扣减）：', '100');
    if (!raw) return;
    try { await api('/admin/users/' + b.dataset.credits + '/credits', { method: 'PUT', body: JSON.stringify({ amount: Number(raw), reason: 'admin 后台调整' }) }); toast('积分已调整', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
    const next = b.dataset.cur === 'active' ? 'disabled' : 'active';
    try { await api('/admin/users/' + b.dataset.status + '/status', { method: 'PUT', body: JSON.stringify({ status: next }) }); toast('已更新', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-pass]').forEach((b) => b.onclick = async () => {
    const pw = prompt('设置新密码（至少 6 位）：');
    if (!pw) return;
    try { await api('/admin/users/' + b.dataset.pass + '/password', { method: 'PUT', body: JSON.stringify({ password: pw }) }); toast('密码已重置', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
  bindPager();
}

/* ---------- 套餐 ---------- */
async function viewPackages() {
  const list = await api('/admin/packages');
  const rows = (list || []).map((p) => '<tr><td>' + esc(p.name) + '</td><td class="right">' + p.credits + '</td><td class="right">¥' + yuan(p.price) + '</td>'
    + '<td><span class="tag ' + (p.isActive ? 'ok' : 'bad') + '">' + (p.isActive ? '在售' : '已下架') + '</span></td>'
    + '<td class="muted">' + esc(p.description || '') + '</td>'
    + '<td class="right"><button class="sm" data-edit="' + esc(p.id) + '">改价/改积分</button><button class="sm danger" data-del="' + esc(p.id) + '">下架</button></td></tr>').join('');
  return '<h2>积分套餐</h2><p class="sub">价格以「元」输入，服务端按分存储（原版占位价：999 积分 = 0.01 元）</p>'
    + '<div class="panel"><table><thead><tr><th>名称</th><th class="right">积分</th><th class="right">价格</th><th>状态</th><th>说明</th><th></th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="6" class="empty">暂无套餐</td></tr>') + '</tbody></table>'
    + '<div class="toolbar" style="margin-top:14px"><input id="pk-name" placeholder="套餐名（如 黄金套餐）" style="min-width:180px" />'
    + '<input id="pk-credits" type="number" placeholder="积分" style="min-width:100px" />'
    + '<input id="pk-price" type="number" step="0.01" placeholder="价格（元）" style="min-width:120px" />'
    + '<button class="primary" id="pk-add">新建套餐</button></div></div>';
}
async function bindPackages() {
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const credits = prompt('积分数量：'); if (credits == null) return;
    const price = prompt('价格（元）：'); if (price == null) return;
    try { await api('/admin/packages/' + b.dataset.edit, { method: 'PATCH', body: JSON.stringify({ credits: Number(credits), price: Number(price) }) }); toast('已更新', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('下架该套餐？（不影响历史订单）')) return;
    try { await api('/admin/packages/' + b.dataset.del, { method: 'DELETE' }); toast('已下架', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#pk-add').onclick = async () => {
    try {
      await api('/admin/packages', { method: 'POST', body: JSON.stringify({ name: $('#pk-name').value.trim(), credits: Number($('#pk-credits').value), price: Number($('#pk-price').value) }) });
      toast('已创建', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ---------- 兑换码 ---------- */
async function viewCodes() {
  const p = new URLSearchParams({ page: state.page, limit: 20 });
  if (state.status) p.set('status', state.status);
  const r = await api('/admin/redemption-codes?' + p);
  const CS = { unused: '未使用', used: '已使用', disabled: '已禁用', expired: '已过期' };
  const rows = (r.items || []).map((c) => '<tr><td class="mono">' + esc(c.code) + '</td><td>' + esc(c.packageId) + '</td>'
    + '<td><span class="tag ' + (c.status === 'unused' ? 'ok' : c.status === 'used' ? '' : 'bad') + '">' + (CS[c.status] || esc(c.status)) + '</span></td>'
    + '<td class="right">' + c.validDays + '</td><td>' + dt(c.expiresAt) + '</td><td>' + dt(c.usedAt) + '</td>'
    + '<td class="muted">' + esc(c.note || '') + '</td>'
    + '<td class="right">' + (c.status === 'unused' ? '<button class="sm" data-dis="' + esc(c.id) + '">禁用</button>' : '') + '<button class="sm danger" data-del="' + esc(c.id) + '">删除</button></td></tr>').join('');
  return '<h2>兑换码</h2><p class="sub">共 ' + r.total + ' 条 · 用于开通团队套餐（traffic / private-domain / flagship）</p>'
    + '<div class="panel"><div class="toolbar"><select id="cd-status"><option value="">全部状态</option>'
    + '<option value="unused" ' + (state.status === 'unused' ? 'selected' : '') + '>未使用</option>'
    + '<option value="used" ' + (state.status === 'used' ? 'selected' : '') + '>已使用</option></select><button id="cd-search">查询</button></div>'
    + '<table><thead><tr><th>兑换码</th><th>套餐</th><th>状态</th><th class="right">有效天数</th><th>到期</th><th>使用时间</th><th>备注</th><th></th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="8" class="empty">暂无兑换码</td></tr>') + '</tbody></table>' + pager(r)
    + '<div class="toolbar" style="margin-top:14px"><select id="cd-pkg" style="min-width:160px"><option value="traffic">流量操盘版</option><option value="private-domain">私域运营版</option><option value="flagship">旗舰版</option></select>'
    + '<input id="cd-count" type="number" value="10" style="min-width:90px" /><input id="cd-days" type="number" value="30" style="min-width:100px" />'
    + '<input id="cd-note" placeholder="备注（可选）" style="min-width:160px" /><button class="primary" id="cd-add">批量生成</button></div></div>';
}
async function bindCodes() {
  $('#cd-search').onclick = () => { state.status = $('#cd-status').value; state.page = 1; render(); };
  $('#cd-add').onclick = async () => {
    try {
      const r = await api('/admin/redemption-codes', { method: 'POST', body: JSON.stringify({ packageId: $('#cd-pkg').value, count: Number($('#cd-count').value), validDays: Number($('#cd-days').value), note: $('#cd-note').value.trim() }) });
      toast('已生成 ' + (r.created || r.count || '') + ' 个兑换码', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  };
  document.querySelectorAll('[data-dis]').forEach((b) => b.onclick = async () => {
    try { await api('/admin/redemption-codes/' + b.dataset.dis, { method: 'PUT', body: JSON.stringify({ status: 'disabled' }) }); toast('已禁用', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('删除该兑换码？')) return;
    try { await api('/admin/redemption-codes/' + b.dataset.del, { method: 'DELETE' }); toast('已删除', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  bindPager();
}

/* ---------- AI 员工 ---------- */
async function viewEmployees() {
  const list = await api('/admin/employees');
  const rows = (list || []).map((e) => '<tr><td class="mono">' + esc(e.slug) + '</td><td>' + esc(e.name) + '</td>'
    + '<td class="muted">' + esc((e.title || '').slice(0, 40)) + '</td><td class="right">' + e.price + '</td><td>' + esc(e.priceDisplay || '') + '</td>'
    + '<td>' + esc(e.requiredPackage || '—') + '</td><td><span class="tag ' + (e.isActive ? 'ok' : 'bad') + '">' + (e.isActive ? '上架' : '下架') + '</span></td>'
    + '<td class="right">' + (e.downloads || 0) + '</td>'
    + '<td class="right"><button class="sm" data-price="' + esc(e.id) + '" data-cur="' + e.price + '">改价</button><button class="sm" data-toggle="' + esc(e.id) + '">' + (e.isActive ? '下架' : '上架') + '</button></td></tr>').join('');
  return '<h2>AI 员工</h2><p class="sub">共 ' + (list || []).length + ' 个 · 价格为「积分/天」原版口径（990 = ¥9.9/天）</p>'
    + '<div class="panel"><table><thead><tr><th>slug</th><th>名称</th><th>岗位</th><th class="right">价/天</th><th>展示价</th><th>所需套餐</th><th>状态</th><th class="right">安装量</th><th></th></tr></thead><tbody>'
    + (rows || '<tr><td colspan="9" class="empty">暂无员工</td></tr>') + '</tbody></table></div>';
}
async function bindEmployees() {
  document.querySelectorAll('[data-price]').forEach((b) => b.onclick = async () => {
    const price = prompt('新的价格（积分/天）：', b.dataset.cur); if (price == null) return;
    const display = prompt('展示文案（如 ¥9.9/天）：') || '';
    try { await api('/admin/employees/' + b.dataset.price, { method: 'PUT', body: JSON.stringify({ price: Number(price), priceDisplay: display }) }); toast('已更新', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
    try { await api('/admin/employees/' + b.dataset.toggle + '/toggle', { method: 'PUT', body: '{}' }); toast('已切换', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------- 定价 ---------- */
async function viewPricing() {
  const models = await api('/admin/model-pricing');
  const media = await api('/admin/media-pricing');
  const usage = await api('/admin/media/usage?days=7');
  const pending = await api('/admin/media/pending-review');
  const usageRows = (usage.items || []).map((x) => '<tr><td>' + esc(x.taskType) + '</td><td class="right">' + esc(x.count) + '</td><td class="right">' + esc(x.upstreamCoins) + '</td><td class="right">' + esc(x.unknownUpstreamCount) + '</td><td class="right">' + esc(x.chargedCredits) + '</td><td>' + esc(x.costStatus) + '</td></tr>').join('');
  const pendingRows = (pending || []).map((x) => '<tr><td>' + esc(x.taskId) + '</td><td>' + esc(x.userId) + '</td><td>' + esc(x.taskType) + '</td><td>' + esc(x.estimatedAmount) + '</td><td>' + esc(x.createdAt) + '</td><td><button class="sm" data-review="' + esc(x.taskId) + '">核对</button></td></tr>').join('');
  const mrows = (models || []).map((m) => '<tr><td class="mono">' + esc(m.modelId) + '</td><td>' + esc(m.modelName) + '</td><td>' + esc(m.provider || '') + '</td>'
    + '<td class="mono muted">' + esc(m.upstreamModelId || '') + '</td><td>' + esc(m.pricingMode) + '</td><td class="right">' + m.pricePerRequest + '</td>'
    + '<td class="right"><button class="sm" data-mp="' + esc(m.id) + '" data-cur="' + m.pricePerRequest + '">改价</button></td></tr>').join('');
  const trows = (media || []).map((m) => '<tr><td class="mono">' + esc(m.taskType) + '</td><td>' + esc(m.displayName || '') + '</td><td>' + esc(m.pricingMode) + '</td>'
    + '<td class="right">' + (m.pricePerRequest != null ? m.pricePerRequest : '') + '</td><td class="right">' + (m.pricePerInputSecond != null ? m.pricePerInputSecond : '') + '</td>'
    + '<td class="right"><button class="sm" data-mdp="' + esc(m.id) + '" data-cur="' + (m.pricePerRequest != null ? m.pricePerRequest : m.pricePerInputSecond) + '">改价</button></td></tr>').join('');
  return '<h2>模型与媒体定价</h2><p class="sub">原版全部为占位价（1 积分/次、0 token 单价）；改完不要重跑 seed，否则被覆盖</p>'
    + '<div class="panel"><h2 style="font-size:15px">待人工核对的提交</h2><p class="sub">先查实上游是否创建任务，再登记核对依据；未确认前请勿退款或重试。</p><table><thead><tr><th>预占编号</th><th>用户</th><th>类型</th><th>预扣积分</th><th>创建时间</th><th></th></tr></thead><tbody>' + (pendingRows || '<tr><td colspan="6" class="empty">暂无</td></tr>') + '</tbody></table></div>'
    + '<div class="panel"><h2 style="font-size:15px">近 7 天媒体消耗</h2><p class="sub">上游币与积分分别统计，换算关系尚未确定；未返回上游用量的任务单独计数。积分含进行中预扣。</p><table><thead><tr><th>任务类型</th><th class="right">任务数</th><th class="right">已知上游币</th><th class="right">上游用量未知</th><th class="right">已扣积分</th><th>成本</th></tr></thead><tbody>'
    + (usageRows || '<tr><td colspan="6" class="empty">暂无</td></tr>') + '</tbody></table></div>'
    + '<div class="panel"><h2 style="font-size:15px">模型（按次）</h2><table><thead><tr><th>modelId</th><th>展示名</th><th>provider</th><th>上游 id</th><th>模式</th><th class="right">积分/次</th><th></th></tr></thead><tbody>'
    + (mrows || '<tr><td colspan="7" class="empty">暂无</td></tr>') + '</tbody></table></div>'
    + '<div class="panel"><h2 style="font-size:15px">媒体任务</h2><table><thead><tr><th>taskType</th><th>名称</th><th>模式</th><th class="right">积分/次</th><th class="right">积分/输入秒</th><th></th></tr></thead><tbody>'
    + (trows || '<tr><td colspan="6" class="empty">暂无</td></tr>') + '</tbody></table></div>';
}
async function bindPricing() {
  document.querySelectorAll('[data-review]').forEach((b) => b.onclick = async () => {
    const action = prompt('核实后输入：refund（未创建，退款）或 track（已创建，继续跟踪）');
    if (action == null) return;
    if (!['refund', 'track'].includes(action)) { toast('操作无效', 'err'); return; }
    const upstreamTaskId = action === 'track' ? prompt('输入已核实的上游任务编号') : undefined;
    if (action === 'track' && !upstreamTaskId) return;
    const reason = prompt('填写核对依据（4 至 500 字）'); if (!reason) return;
    if (!confirm(action === 'refund' ? '确认上游未创建任务并退款？' : '确认关联该上游任务？')) return;
    try { await api('/admin/media/pending-review/' + encodeURIComponent(b.dataset.review) + '/resolve', { method: 'POST', body: JSON.stringify({ action, upstreamTaskId, reason }) }); toast('已登记核对结果', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-mp]').forEach((b) => b.onclick = async () => {
    const v = prompt('每请求积分：', b.dataset.cur); if (v == null) return;
    try { await api('/admin/model-pricing/' + b.dataset.mp, { method: 'PUT', body: JSON.stringify({ pricePerRequest: Number(v) }) }); toast('已更新', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  document.querySelectorAll('[data-mdp]').forEach((b) => b.onclick = async () => {
    const v = prompt('积分值：', b.dataset.cur); if (v == null) return;
    try { await api('/admin/media-pricing/' + b.dataset.mdp, { method: 'PUT', body: JSON.stringify({ pricePerRequest: Number(v) }) }); toast('已更新', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ---------- 站点配置 ---------- */
const SKIP_KEYS = { volcengineModels: 1, updatedAt: 1, createdAt: 1, id: 1 };
function genericForm(obj) {
  return Object.entries(obj || {}).filter(([k, v]) => !SKIP_KEYS[k] && (v === null || typeof v !== 'object')).map(([k, v]) => {
    const isNum = typeof v === 'number';
    return '<div class="field"><label>' + esc(k) + '</label><input data-key="' + esc(k) + '" type="' + (isNum ? 'number' : 'text') + '" value="' + esc(v == null ? '' : v) + '" /></div>';
  }).join('');
}
function collectForm(root) {
  const out = {};
  root.querySelectorAll('[data-key]').forEach((el) => { out[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value; });
  return out;
}
async function viewSite() {
  const site = await api('/admin/site-config');
  const ai = await api('/admin/ai-api-config').catch(() => null);
  return '<h2>站点配置</h2><p class="sub">含密钥的字段显示为 ****，原样提交表示不变</p>'
    + '<div class="panel"><h2 style="font-size:15px">站点</h2><div class="grid2">' + genericForm(site) + '</div>'
    + '<div class="toolbar" style="margin-top:12px"><button class="primary" id="site-save">保存站点配置</button></div></div>'
    + '<div class="panel"><h2 style="font-size:15px">AI 接口（模型中转）</h2>'
    + (ai ? '<div class="grid2">' + genericForm(ai) + '</div><div class="toolbar" style="margin-top:12px"><button class="primary" id="ai-save">保存 AI 接口</button></div>' : '<p class="muted">接口不可用</p>')
    + '</div>';
}
async function bindSite() {
  const s = $('#site-save');
  if (s) s.onclick = async () => {
    try { await api('/admin/site-config', { method: 'PUT', body: JSON.stringify(collectForm(s.closest('.panel'))) }); toast('站点配置已保存', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  const a = $('#ai-save');
  if (a) a.onclick = async () => {
    try { await api('/admin/ai-api-config', { method: 'PUT', body: JSON.stringify(collectForm(a.closest('.panel'))) }); toast('AI 接口已保存', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
}

render();
