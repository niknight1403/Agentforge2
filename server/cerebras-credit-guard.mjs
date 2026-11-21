export function creditGate({balanceUsd, requestUsd, paidBudgetUsd = 0} = {}) {
  const valid = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  if (paidBudgetUsd !== 0) return {allowed:false, reason:'PAID_SPEND_DISABLED'};
  if (!valid(balanceUsd)) return {allowed:false, reason:'UNVERIFIED_CREDITS'};
  if (!valid(requestUsd) || requestUsd <= 0) return {allowed:false, reason:'UNKNOWN_REQUEST_COST'};
  return {allowed:balanceUsd >= requestUsd, reason:balanceUsd >= requestUsd ? 'CREDIT_ONLY' : 'INSUFFICIENT_CREDITS'};
}
export function prioritizeRoutes(routes, decision) {
  const eligible = routes.filter(r => r.enabled !== false && (r.provider !== 'cerebras' || decision.allowed));
  return decision.allowed ? eligible.sort((a,b)=>Number(b.provider==='cerebras')-Number(a.provider==='cerebras')) : eligible;
}
