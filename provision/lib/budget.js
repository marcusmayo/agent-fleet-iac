'use strict';
const { runCapture } = require('./util');

// Read a Cost Management budget's current month-to-date spend via the Azure CLI.
// A single clean command (no aggregation-JSON quoting); the budget resource is the
// source of truth for actual spend. Returns { ok:true, amount, unit, limit } or
// { ok:false, reason }.
function readBudgetSpend(budgetName) {
  const r = runCapture('az', ['consumption', 'budget', 'show', '--budget-name', budgetName, '-o', 'json']);
  if (r.notFound) return { ok: false, reason: 'az CLI not found' };
  if (!r.ok) return { ok: false, reason: (r.stderr || 'az returned non-zero').split('\n')[0] };
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { ok: false, reason: 'could not parse az output' }; }
  const spend = j && j.currentSpend;
  if (!spend || typeof spend.amount !== 'number') return { ok: false, reason: `budget "${budgetName}" has no currentSpend yet` };
  return {
    ok: true,
    amount: spend.amount,
    unit: spend.unit || 'USD',
    limit: (typeof j.amount === 'number' ? j.amount : null),
  };
}

// Gate: block NEW provisioning if month-to-date spend already meets/exceeds the cap.
// Unreadable spend does NOT block (maxFleet is the hard structural bound); it warns.
function checkBudget(maxMonthlyBudgetUsd, spend) {
  if (!spend || !spend.ok) {
    return { ok: true, warn: true, message: `budget unreadable (${spend ? spend.reason : 'no data'}) — relying on the maxFleet cap` };
  }
  const over = spend.amount >= maxMonthlyBudgetUsd;
  const money = `${spend.unit} ${spend.amount.toFixed(2)}`;
  return {
    ok: !over,
    warn: false,
    over,
    message: over
      ? `month-to-date spend ${money} >= budget ${maxMonthlyBudgetUsd} — refusing new provisioning`
      : `month-to-date spend ${money} of ${maxMonthlyBudgetUsd} (headroom ${(maxMonthlyBudgetUsd - spend.amount).toFixed(2)})`,
  };
}

module.exports = { readBudgetSpend, checkBudget };
