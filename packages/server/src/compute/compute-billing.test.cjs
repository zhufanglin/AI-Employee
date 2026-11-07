const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComputeService } = require('../../dist/compute/compute.service');

function makeHarness({ balance = 10, quotaRemaining = 0, streamBody, price = 1, priceByUsage } = {}) {
  const records = [];
  const transactions = [];
  const state = { balance, quotaUsed: 0 };
  const prisma = {
    aiUsageRecord: { create: async ({ data }) => { records.push(data); } },
  };
  const credits = {
    getBalance: async () => ({ balance: state.balance }),
    consumeCredits: async (_u, amount, description) => {
      if (state.balance < amount) throw new Error('insufficient');
      state.balance -= amount;
      const tx = { id: 'tx-' + (transactions.length + 1), amount: -amount, description };
      transactions.push(tx);
      return tx;
    },
    consumeCreditsWithPartial: async (_u, amount, description) => {
      const actualAmount = Math.min(state.balance, amount);
      if (actualAmount === 0) throw new Error('insufficient');
      state.balance -= actualAmount;
      const transaction = { id: 'tx-' + (transactions.length + 1), amount: -actualAmount, description };
      transactions.push(transaction);
      return { transaction, actualAmount, isPartialDeduct: actualAmount < amount };
    },
    addCredits: async (_u, amount, type, description) => {
      state.balance += amount;
      const tx = { id: 'tx-' + (transactions.length + 1), amount, type, description };
      transactions.push(tx);
      return tx;
    },
  };
  const pricing = {
    calculatePrice: async (_m, inputTokens = 0, outputTokens = 0) =>
      priceByUsage && (inputTokens || outputTokens) ? priceByUsage : price,
    getPricing: async () => ({ pricingMode: 'per_request' }),
  };
  const quota = {
    getMonthlyUsage: async () => ({ quotaRemaining }),
    consumeQuota: async () => { state.quotaUsed += 1; },
  };
  const providers = {
    resolve: async () => ({}),
    streamChat: async () => ({ body: streamBody }),
  };
  const res = { status() { return this; }, setHeader() {}, write() {}, end() {} };
  const svc = new ComputeService(prisma, credits, pricing, quota, providers);
  return { svc, state, records, transactions, res };
}

const usageStream = (prompt = 1, completion = 1) => (async function* () {
  yield Buffer.from('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  yield Buffer.from(`data: {"usage":{"prompt_tokens":${prompt},"completion_tokens":${completion},"total_tokens":${prompt + completion}}}\n\n`);
  yield Buffer.from('data: [DONE]\n\n');
})();

const interruptedStream = () => (async function* () {
  yield Buffer.from('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
  throw new Error('socket hang up');
})();

test('completed paid stream charges exactly once (no double deduction)', async () => {
  const h = makeHarness({ streamBody: usageStream() });
  await h.svc.processComputeStreamRequest('u1', { model: 'test' }, h.res);
  assert.equal(h.state.balance, 9, 'one credit charged once');
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].creditsCharged, 1);
  assert.equal(h.records[0].needsReview, false);
});

test('interrupted stream without usage refunds pre-deduct and flags review', async () => {
  const h = makeHarness({ streamBody: interruptedStream() });
  await h.svc.processComputeStreamRequest('u1', { model: 'test' }, h.res);
  assert.equal(h.state.balance, 10, 'pre-deduct refunded in full');
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].creditsCharged, 0);
  assert.equal(h.records[0].needsReview, true);
  assert.ok(String(h.records[0].reviewNote).includes('中断'));
});

test('interrupted stream with usage bills actual usage', async () => {
  const h = makeHarness({ streamBody: usageStream(3, 4) });
  await h.svc.processComputeStreamRequest('u1', { model: 'test' }, h.res);
  assert.equal(h.state.balance, 9);
  assert.equal(h.records[0].creditsCharged, 1);
  assert.equal(h.records[0].needsReview, false);
});

test('free quota path consumes quota and never touches credits', async () => {
  const h = makeHarness({ quotaRemaining: 5, streamBody: usageStream() });
  await h.svc.processComputeStreamRequest('u1', { model: 'test' }, h.res);
  assert.equal(h.state.balance, 10, 'credits untouched inside free quota');
  assert.equal(h.state.quotaUsed, 1);
  assert.equal(h.records[0].creditsCharged, 0);
});

test('usage returned but cost exceeds balance: charge capped at balance, no clawback', async () => {
  const h = makeHarness({ balance: 3, streamBody: usageStream(10, 10), price: 1, priceByUsage: 10 });
  await h.svc.processComputeStreamRequest('u1', { model: 'test' }, h.res);
  assert.equal(h.state.balance, 0, 'balance capped at zero, not negative');
  assert.equal(h.records[0].creditsCharged, 3, 'records what was actually charged');
  assert.equal(h.records[0].isPartialDeduct, true);
  assert.ok(String(h.records[0].reviewNote).includes('封顶'));
});
