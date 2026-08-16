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
  // az returns these as STRINGS ("150.0", "19.7185136511700"), not numbers. A strict
  // typeof check therefore read a healthy, reporting budget as "no currentSpend yet" --
  // and because checkBudget degrades an unreadable budget to a warning, the spend cap
  // silently never enforced anything on any lane. The failure was invisible precisely
  // because the fallback was graceful: a control that cannot read its input and says so
  // quietly is indistinguishable from one that is passing.
  //
  // Coerce, then verify the coercion. Number('') and Number(null) are 0, which would be
  // worse than useless here (a 0 spend always passes), so empty/absent is rejected
  // explicitly rather than allowed to look like a clean bill.
  const num = (x) => {
    if (x === null || x === undefined || x === '') return null;
    const n = typeof x === 'number' ? x : Number(String(x).trim());
    return Number.isFinite(n) ? n : null;
  };
  const spend = j && j.currentSpend;
  const amount = spend ? num(spend.amount) : null;
  if (amount === null) return { ok: false, reason: `budget "${budgetName}" has no readable currentSpend` };
  return {
    ok: true,
    amount,
    unit: (spend && spend.unit) || 'USD',
    limit: num(j.amount),
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
