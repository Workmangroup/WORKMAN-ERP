/** En-tête de page + barre de commandes (style Dynamics). */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="border-b border-line bg-white">
      <div className="flex min-h-10 items-center gap-1 border-b border-line px-4 py-1">{actions}</div>
      <div className="px-6 py-4">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-ink-soft">{description}</p>}
      </div>
    </div>
  )
}
