import test from 'node:test'
import assert from 'node:assert/strict'

import {
  budgetToWindows,
  fetchBilling,
  poolForKeyType,
  resetSpan,
  usageFromBilling,
} from '../src/billing.mjs'

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

const RESET = new Date(Date.now() + 5 * 86_400_000).toISOString()

test('both pools become windows, the non-counting one aside', () => {
  const windows = budgetToWindows(
    {
      vibe_budget: { usage_percentage: 42.5, initial_budget: 300, reset_at: RESET, payg_enabled: true },
      api_budget: { usage_percentage: 100, initial_budget: 30, reset_at: RESET },
    },
    'vibe_budget',
  )
  assert.equal(windows.length, 2)
  assert.equal(windows[0].name, 'Monthly Vibe')
  assert.equal(windows[0].used, 42.5)
  assert.equal(windows[0].limit, 300)
  assert.equal(windows[0].amount, 127.5)
  assert.equal(windows[0].unit, 'USD')
  assert.equal(windows[0].display, '$127.50 / $300.00')
  assert.equal(windows[0].aside, undefined)
  assert.equal(windows[0].payg_enabled, true)
  assert.equal(windows[0].resetsAt, Date.parse(RESET))
  assert.ok(windows[0].span > 4 * 86_400)

  assert.equal(windows[1].name, 'Platform API credits')
  assert.equal(windows[1].amount, 30)
  assert.equal(windows[1].aside, true)
})

test('the counting pool flips with the key type', () => {
  assert.equal(poolForKeyType('vibe'), 'vibe_budget')
  assert.equal(poolForKeyType('unknown'), 'vibe_budget')
  assert.equal(poolForKeyType('api'), 'api_budget')

  const budget = {
    vibe_budget: { usage_percentage: 10, initial_budget: 300 },
    api_budget: { usage_percentage: 10, initial_budget: 30 },
  }
  assert.equal(budgetToWindows(budget, 'api_budget')[0].aside, true)
  assert.equal(budgetToWindows(budget, 'all')[0].aside, undefined)
})

test('a missing initial_budget still reports the percentage', () => {
  const [window] = budgetToWindows({ vibe_budget: { usage_percentage: 12.5 } }, 'vibe_budget')
  assert.equal(window.used, 12.5)
  assert.equal(window.limit, 0)
  assert.equal(window.amount, 0)
  assert.equal(window.span, 30 * 86_400)
  assert.equal(window.resetsAt, undefined)
})

test('a 403 on /budget degrades to the plan instead of throwing', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/billing/subscription')) {
      return json({ plan_name: 'Vibe Pro', vibe_payg_enabled: true })
    }
    return json({ detail: 'forbidden' }, 403)
  }
  const billing = await fetchBilling('k', { fetch: fetchImpl })
  assert.equal(billing.subscription.plan_name, 'Vibe Pro')
  assert.equal(billing.subscriptionStatus, 200)
  assert.equal(billing.budget, null)
  assert.equal(billing.budgetStatus, 403)

  const usage = usageFromBilling(billing, { keyType: 'vibe' })
  assert.equal(usage.plan, 'Vibe Pro')
  assert.deepEqual(usage.windows, [])
  assert.equal(usage.payg, true)
})

test('usageFromBilling falls back to the whoami plan name', () => {
  const usage = usageFromBilling(
    { subscription: null, budget: { api_budget: { usage_percentage: 1, initial_budget: 30 } } },
    { keyType: 'api', planName: 'Vibe Max' },
  )
  assert.equal(usage.plan, 'Vibe Max')
  assert.equal(usage.windows.length, 1)
  assert.equal(usage.windows[0].aside, undefined)
})

test('resetSpan parses ISO dates and rejects nonsense', () => {
  assert.ok(resetSpan(RESET) > 4 * 86_400)
  assert.equal(resetSpan('not a date'), undefined)
  assert.equal(resetSpan(new Date(Date.now() - 1_000).toISOString()), undefined)
  assert.equal(resetSpan(undefined), undefined)
})
