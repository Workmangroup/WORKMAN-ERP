/** Prévision simple : régression linéaire sur une série mensuelle (pure, testable). */

export interface Trend { slope: number; intercept: number; next: number[]; r2: number }

/** Ajuste une droite sur les valeurs (x = 0..n-1) et projette les `steps` valeurs suivantes (plancher à 0). */
export function linearTrend(values: number[], steps: number): Trend {
  const n = values.length
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, next: Array.from({ length: steps }, () => values[0] ?? 0), r2: 0 }
  const mx = (n - 1) / 2
  const my = values.reduce((s, v) => s + v, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (values[i] - my)
    sxx += (i - mx) ** 2
    syy += (values[i] - my) ** 2
  }
  const slope = sxx === 0 ? 0 : sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy)
  const next = Array.from({ length: steps }, (_, k) => Math.max(0, intercept + slope * (n + k)))
  return { slope, intercept, next, r2 }
}

/** Mois suivant « AAAA-MM » décalé de k mois. */
export function addMonths(yyyymm: string, k: number): string {
  const [y, m] = yyyymm.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + k, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
