import { StockNav } from '@/features/stock/components/stock-nav'

export default function StockLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <StockNav />
      {children}
    </>
  )
}
