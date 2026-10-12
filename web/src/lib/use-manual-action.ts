'use client'

import { startTransition, useActionState } from 'react'
import type { FormState } from '@/features/auth/types'

/**
 * Variante de useActionState pour les formulaires qui contiennent des champs contrôlés (listes dépendantes) :
 * React 19 réinitialise le formulaire après chaque `action`, ce qui vide ces champs après une erreur.
 * Ici la soumission passe par onSubmit : rien n'est réinitialisé, l'utilisateur corrige et renvoie.
 */
export function useManualAction(action: (prev: FormState, fd: FormData) => Promise<FormState>, initial: FormState = null) {
  const [state, dispatch, pending] = useActionState(action, initial)
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    startTransition(() => dispatch(fd))
  }
  return [state, onSubmit, pending] as const
}
