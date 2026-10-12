import { ProductionNav } from '@/features/production/components/production-nav'

export default function ProductionLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ProductionNav />
      {children}
    </>
  )
}
