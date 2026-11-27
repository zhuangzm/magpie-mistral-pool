// Plan and allowance reads, shaped as Magpie usage windows.
//
// GET {base}/billing/subscription and GET {base}/billing/budget are the two
// reads the official CLI makes. /budget needs a permission some members do
// not have; a 403 there is normal and must degrade to "plan only", never
// break the usage card.

import { baseUrlOf, sanitizeHeaders } from './core.mjs'

const POOLS = [
  ['vibe_budget', 'Monthly Vibe'],
  ['api_budget', 'Platform API credits'],
]

/** The allowance pool a key's own usage is billed to. */
export function poolForKeyType(keyType) {
  return keyType === 'api' ? 'api_budget' : 'vibe_budget'
}

const usd = (value) => Math.round(value * 1e6) / 1e6

/** Seconds from now until an ISO reset time, or undefined when unparseable. */
export function resetSpan(resetAt) {
  if (typeof resetAt !== 'string') return undefined
  const at = Date.parse(resetAt)
  if (!Number.isFinite(at)) return undefined
  const delta = at - Date.now()
  return delta > 0 ? Math.round(delta / 1000) : undefined
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£' }

function money(amount, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] ?? ''
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency ?? ''}`.trim()
}

/**
 * Turn a /billing/budget response into usage windows.
 *
 * `counting` picks the pool routing reads. The other pool is still attached
 * with `aside: true`, so the card shows both allowances while only the key's
 * own pool counts. "all" makes both count.
 */
export function budgetToWindows(budget, counting = 'vibe_budget') {
  const windows = []
  for (const [poolKey, name] of POOLS) {
    const pool = budget?.[poolKey]
    if (!pool || typeof pool.usage_percentage !== 'number' || !Number.isFinite(pool.usage_percentage)) continue
    const limit = Number(pool.initial_budget) > 0 ? Number(pool.initial_budget) : 0
    const used = pool.usage_percentage
    const amount = limit > 0 ? usd((limit * used) / 100) : 0
    const currency = pool.currency ?? 'USD'
    const resetsAt = typeof pool.reset_at === 'string' ? Date.parse(pool.reset_at) : NaN
    const window = {
      name,
      used,
      limit,
      amount,
      unit: currency,
      span: resetSpan(pool.reset_at) ?? 30 * 86_400,
      display: `${money(amount, currency)} / ${money(limit, currency)}`,
    }
    if (Number.isFinite(resetsAt)) window.resetsAt = resetsAt
    if (pool.payg_enabled !== undefined) window.payg_enabled = pool.payg_enabled
    if (counting !== 'all' && poolKey !== counting) window.aside = true
    windows.push(window)
  }
  return windows
}

/**
 * Read both billing endpoints. Never throws for an HTTP failure: each side
 * carries its status so a 403 on /budget can be told apart from a dead
 * network, and both data fields stay null.
 */
export async function fetchBilling(key, options = {}) {
  const base = baseUrlOf(options)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const headers = sanitizeHeaders(null, { key, userAgent: options.userAgent })
  const timeoutMs = options.timeoutMs ?? 8_000

  const ask = async (path) => {
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        await response.body?.cancel?.().catch?.(() => {})
        return { status: response.status, data: null }
      }
      return { status: response.status, data: await response.json().catch(() => null) }
    } catch {
      return { status: 0, data: null }
    }
  }

  const [subscription, budget] = await Promise.all([
    ask('/billing/subscription'),
    ask('/billing/budget'),
  ])
  return {
    subscription: subscription.data,
    budget: budget.data,
    subscriptionStatus: subscription.status,
    budgetStatus: budget.status,
  }
}

/** The Magpie usage shape: plan plus the windows the key's own pool leads. */
export function usageFromBilling(billing, info = {}) {
  const counting = poolForKeyType(info.keyType)
  const windows = budgetToWindows(billing?.budget, counting)
  const plan = billing?.subscription?.plan_name ?? info.planName ?? undefined
  const payg = billing?.subscription?.vibe_payg_enabled ?? billing?.budget?.vibe_budget?.payg_enabled
  const out = { windows }
  if (plan) out.plan = plan
  if (payg !== undefined) out.payg = payg
  return out
}
