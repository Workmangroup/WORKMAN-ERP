import { MrpNav } from '@/features/mrp/components/mrp-nav'

export default function MrpLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <MrpNav />
      {children}
    </>
  )
}
