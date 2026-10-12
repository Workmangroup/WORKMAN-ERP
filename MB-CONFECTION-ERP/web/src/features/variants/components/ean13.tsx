import { ean13Modules } from '@/lib/variants/options'

/** Code-barres EAN-13 dessiné en SVG (prêt à imprimer) ; pour les autres GTIN, le numéro seul. */
export function Ean13({ code, className }: { code: string; className?: string }) {
  const modules = ean13Modules(code)
  if (!modules) return <p className={className ?? 'font-mono text-sm tracking-widest'}>{code}</p>
  const w = 9
  const quiet = 11 * w
  const width = modules.length * w + quiet * 2
  const guard = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94])
  const bars: React.ReactNode[] = []
  let i = 0
  while (i < modules.length) {
    if (modules[i] === '1') {
      let j = i
      while (j < modules.length && modules[j] === '1' && guard.has(j) === guard.has(i)) j++
      bars.push(<rect key={i} x={quiet + i * w} y={0} width={(j - i) * w} height={guard.has(i) ? 150 : 135} fill="currentColor" />)
      i = j
    } else i++
  }
  const text = (s: string, x: number) => <text key={x} x={x} y={168} fontSize={26} fontFamily="monospace" textAnchor="middle" fill="currentColor" letterSpacing={9}>{s}</text>
  return (
    <svg viewBox={`0 0 ${width} 180`} className={className ?? 'h-20 w-auto text-ink'} role="img" aria-label={`Code-barres EAN-13 ${code}`}>
      <rect width={width} height={180} fill="white" />
      {bars}
      <text x={quiet - 30} y={168} fontSize={26} fontFamily="monospace" textAnchor="end" fill="currentColor">{code[0]}</text>
      {text(code.slice(1, 7), quiet + 3 * w + 21 * w)}
      {text(code.slice(7), quiet + 50 * w + 21 * w)}
    </svg>
  )
}
