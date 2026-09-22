import { pool } from '../config/db.js';

/**
 * Journalise une action. Ne lève jamais d'erreur : un échec de journalisation
 * ne doit pas faire échouer l'action métier (il est tracé dans la console).
 */
export async function audit(req, action, { entite = null, entiteId = null, details = null, userId } = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entite, entite_id, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ?? req?.user?.id ?? null,
        action,
        entite,
        entiteId,
        req?.ip ?? null,
        req?.get?.('user-agent')?.slice(0, 255) ?? null,
        details ? JSON.stringify(details) : null,
      ],
    );
  } catch (err) {
    console.error('[audit] échec de journalisation', action, err.message);
  }
}
