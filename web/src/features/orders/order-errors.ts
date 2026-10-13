import { mrpErrorMessage } from '@/features/mrp/errors'

const BY_CODE: [string, string][] = [
  ['ORDER_REASON_REQUIRED', 'Indiquez le motif (5 caractères minimum) : il est conservé dans l’historique.'],
  ['ORDER_HAS_OPEN_SHIPMENTS', 'Des expéditions sont en cours sur cette commande : terminez-les ou annulez-les avant d’annuler le reliquat.'],
  ['ORDER_HAS_ACTIVITY', 'Cette commande a déjà des livraisons ou une production : utilisez l’annulation motivée du reliquat.'],
  ['ORDER_QTY_BELOW_COMMITTED', 'La quantité ne peut pas passer sous ce qui est déjà livré, annulé ou facturé.'],
  ['ORDER_SCHEDULE_LOCKED', 'Un échéancier existe : la quantité ne se modifie pas après confirmation.'],
  ['ORDER_SCHEDULE_MISMATCH', 'La somme des échéances doit être égale à la quantité de la ligne.'],
  ['ORDER_SCHEDULE_INVALID', 'Échéancier invalide : une date et une quantité positive par échéance.'],
  ['ORDER_NO_OPEN_LINE', 'Reliquat insuffisant sur une ligne de cet article pour cette expédition.'],
  ['ORDER_FULFILMENT_LOCKED', 'Le livré et l’annulé ne se saisissent pas à la main : ils sont alimentés par les expéditions.'],
  ['ORDER_QTY_INVALID', 'La quantité doit être positive.'],
  ['ORDER_LOCKED', 'Cette commande est figée : utilisez les modifications versionnées.'],
  ['ORDER_BAD_STATUS', 'Cette action n’est pas possible dans l’état actuel de la commande.'],
]

export function orderErrorMessage(err: { message?: string; code?: string; details?: string | null } | null | undefined): string {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  for (const [k, msg] of BY_CODE) if (text.includes(k)) return msg
  return mrpErrorMessage(err)
}
