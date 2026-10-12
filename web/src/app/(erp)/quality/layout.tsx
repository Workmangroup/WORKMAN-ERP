import { QualityNav } from '@/features/quality/components/quality-nav'

export default function QualityLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <QualityNav />
      {children}
    </>
  )
}
