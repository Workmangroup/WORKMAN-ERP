import { CommercialNav } from '@/features/commercial/components/commercial-nav'

export default function CommercialLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CommercialNav />
      {children}
    </>
  )
}
