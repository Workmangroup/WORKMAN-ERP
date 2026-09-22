/**
 * Génère le prochain numéro d'un ticket (ex. REC-2026-0154) de façon atomique.
 * `LAST_INSERT_ID(expr)` mémorise la valeur pour la connexion courante : deux
 * requêtes simultanées ne peuvent pas obtenir le même numéro.
 * Doit être appelée avec la connexion de la transaction en cours.
 */
export async function nextNumero(conn, prefixe, date = new Date()) {
  const annee = date.getFullYear();
  await conn.query(
    `INSERT INTO sequences (prefixe, annee, dernier) VALUES (?, ?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE dernier = LAST_INSERT_ID(dernier + 1)`,
    [prefixe, annee],
  );
  const [[{ n }]] = await conn.query('SELECT LAST_INSERT_ID() AS n');
  return `${prefixe}-${annee}-${String(n).padStart(4, '0')}`;
}
