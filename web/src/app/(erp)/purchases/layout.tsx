import { PurchasesNav } from '@/features/purchases/components/purchases-nav'

export default function PurchasesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PurchasesNav />
      {children}
    </>
  )
}
