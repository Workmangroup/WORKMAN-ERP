import { redirect } from 'next/navigation'
import { ROUTES } from '@/lib/auth/constants'

export default function Home() {
  redirect(ROUTES.home) // le middleware renvoie vers /login si non connecté
}
