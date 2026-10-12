/**
 * Battement de cœur d'activité : le middleware (qui valide la session et
 * renouvelle le cookie d'activité) répond avant d'arriver ici. 401 si la
 * session a expiré ou si l'inactivité maximale est dépassée.
 */
export const dynamic = 'force-dynamic'

export async function POST() {
  return new Response(null, { status: 204 })
}
