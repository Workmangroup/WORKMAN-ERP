/** Traduit les erreurs levées par les fonctions SQL rbac_* (code RBAC_* dans le message). */
const MESSAGES: Record<string, (detail?: string) => string> = {
  RBAC_FORBIDDEN: () => 'Vous n’avez pas la permission d’effectuer cette action.',
  RBAC_ESCALATION: (d) => `Vous ne pouvez pas accorder${d ? ` « ${d} »` : ' une permission'} que vous ne détenez pas vous-même.`,
  RBAC_SYSTEM_ROLE: () => 'Les rôles système ne peuvent pas être supprimés.',
  RBAC_ROLE_IN_USE: () => 'Ce rôle est encore affecté à des utilisateurs : retirez-le d’abord.',
  RBAC_LAST_ADMIN: () => 'Action refusée : il doit toujours rester au moins un administrateur actif.',
  RBAC_ADMIN_PROTECTED: (d) => `Le rôle Administrateur doit conserver${d ? ` « ${d} »` : ' ses permissions d’administration'}.`,
  RBAC_SELF: () => 'Vous ne pouvez pas désactiver votre propre compte.',
  RBAC_DUPLICATE: () => 'Un rôle avec ce code existe déjà.',
  RBAC_INVALID_CODE: () => 'Code invalide : lettres minuscules, chiffres et « _ » (2 à 32 caractères, commence par une lettre).',
  RBAC_INVALID_LABEL: () => 'Le libellé est obligatoire.',
  RBAC_NOT_FOUND: () => 'Élément introuvable.',
  RBAC_UNKNOWN_PERMISSION: (d) => `Permission inconnue${d ? ` : ${d}` : ''}.`,
}

export function rbacErrorMessage(err: { message?: string; details?: string | null } | null | undefined): string {
  const text = err?.message ?? ''
  for (const [code, fn] of Object.entries(MESSAGES)) {
    if (text.includes(code)) return fn(err?.details ?? undefined)
  }
  return 'Une erreur est survenue. Réessayez ou contactez un administrateur.'
}

export const isForbidden = (err: { message?: string } | null | undefined) =>
  Boolean(err?.message?.includes('RBAC_FORBIDDEN') || err?.message?.includes('RBAC_ESCALATION'))
