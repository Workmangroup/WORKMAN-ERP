import { Scissors, ShieldCheck, Layers, Truck } from 'lucide-react'

/** Mise en page des écrans d'authentification : panneau de marque + zone de formulaire. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
      <aside className="relative hidden overflow-hidden bg-brand-900 text-white lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(900px 500px at 10% 0%, rgba(0,120,212,.55), transparent 60%), radial-gradient(700px 500px at 100% 100%, rgba(43,136,216,.35), transparent 60%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-sm bg-white/10"><Scissors className="h-5 w-5" /></span>
          <span className="text-lg font-semibold tracking-tight">WORKMAN ERP 360</span>
        </div>

        <div className="relative max-w-lg">
          <h2 className="text-3xl font-semibold leading-tight">Le pilotage de votre confection, de la commande à l’expédition.</h2>
          <ul className="mt-8 space-y-4 text-white/85">
            <li className="flex gap-3"><Layers className="mt-0.5 h-5 w-5 shrink-0" /> Articles, nomenclatures et fiches techniques par client</li>
            <li className="flex gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" /> Certifications et documents toujours à jour</li>
            <li className="flex gap-3"><Truck className="mt-0.5 h-5 w-5 shrink-0" /> Production, qualité et expéditions tracées</li>
          </ul>
        </div>

        <p className="relative text-xs text-white/60">© {new Date().getFullYear()} WORKMAN ERP 360 · Accès réservé aux utilisateurs autorisés</p>
      </aside>

      <main className="flex items-center justify-center bg-white px-6 py-12 sm:px-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  )
}
