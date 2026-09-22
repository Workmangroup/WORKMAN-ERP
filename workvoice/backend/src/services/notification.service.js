import { pool, query } from '../config/db.js';
import { sendMail } from './mailer.js';

/**
 * Crée des notifications in-app pour une liste d'utilisateurs et, si demandé,
 * envoie les e-mails correspondants. À appeler APRÈS le commit de la transaction.
 * Ne lève jamais d'erreur : une notification ratée ne doit pas annuler l'action.
 */
export async function notifyUsers(userIds, { type, titre, message, lien = null }, { email = true } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;

  try {
    await pool.query(
      'INSERT INTO notifications (user_id, type, titre, message, lien) VALUES ?',
      [ids.map((id) => [id, type, titre, message, lien])],
    );

    if (email) {
      const recipients = await query('SELECT email FROM users WHERE id IN (?) AND actif = 1 AND email IS NOT NULL', [ids]);
      for (const { email: to } of recipients) {
        sendMail({ to, titre, message, lien }).catch((err) =>
          console.error('[notification] e-mail non envoyé', to, err.message),
        );
      }
    }
  } catch (err) {
    console.error('[notification] échec', type, err.message);
  }
}

/** Notifie tous les utilisateurs actifs d'un rôle, en excluant éventuellement l'auteur. */
export async function notifyRole(role, payload, { excludeUserId = null, email = true } = {}) {
  try {
    const rows = await query('SELECT id FROM users WHERE role = ? AND actif = 1', [role]);
    const ids = rows.map((r) => r.id).filter((id) => id !== excludeUserId);
    await notifyUsers(ids, payload, { email });
  } catch (err) {
    console.error('[notification] échec notifyRole', role, err.message);
  }
}
