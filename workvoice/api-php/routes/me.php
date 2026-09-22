<?php
declare(strict_types=1);

/** Union « mes tickets » (demandes + réclamations + suggestions) ; chaque partie prend l'id utilisateur. */
function my_tickets_union(array $kinds): string
{
    $parts = [
        'demande' => "SELECT 'demande' AS kind, id, numero_demande AS numero, type_demande AS type, objet, statut,
                             date_creation, date_maj, date_cloture FROM demandes WHERE user_id = ?",
        'reclamation' => "SELECT 'reclamation', id, numero_reclamation, categorie, objet, statut,
                             date_creation, date_maj, date_cloture FROM reclamations WHERE user_id = ?",
        'suggestion' => "SELECT 'suggestion', id, numero_suggestion, theme, objet, statut,
                             date_creation, date_maj, date_cloture FROM suggestions WHERE user_id = ?",
    ];
    return implode(' UNION ALL ', array_intersect_key($parts, array_flip($kinds)));
}

const ALL_KINDS = ['demande', 'reclamation', 'suggestion'];

route('GET', '/me/dashboard', function () {
    $uid = current_user()['id'];

    $counts = q1(
        "SELECT COUNT(*) AS total,
                CAST(COALESCE(SUM(statut NOT IN ('RESOLU','CLOTURE')), 0) AS SIGNED) AS en_cours,
                CAST(COALESCE(SUM(statut IN ('RESOLU','CLOTURE')), 0) AS SIGNED)     AS cloturees,
                CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED)              AS en_attente
         FROM (" . my_tickets_union(ALL_KINDS) . ') x',
        [$uid, $uid, $uid],
    );

    $reponses = q(
        "SELECT c.id, c.message, c.date_creation, 'demande' AS kind, d.id AS ticket_id, d.numero_demande AS numero, d.objet
           FROM commentaires c JOIN demandes d ON d.id = c.demande_id JOIN users a ON a.id = c.user_id
           WHERE d.user_id = ? AND a.role = 'RH'
         UNION ALL
         SELECT c.id, c.message, c.date_creation, 'reclamation', r.id, r.numero_reclamation, r.objet
           FROM commentaires c JOIN reclamations r ON r.id = c.reclamation_id JOIN users a ON a.id = c.user_id
           WHERE r.user_id = ? AND a.role = 'RH'
         UNION ALL
         SELECT c.id, c.message, c.date_creation, 'suggestion', s.id, s.numero_suggestion, s.objet
           FROM commentaires c JOIN suggestions s ON s.id = c.suggestion_id JOIN users a ON a.id = c.user_id
           WHERE s.user_id = ? AND a.role = 'RH'
         ORDER BY date_creation DESC LIMIT 5",
        [$uid, $uid, $uid],
    );

    $recents = q(my_tickets_union(ALL_KINDS) . ' ORDER BY date_creation DESC LIMIT 5', [$uid, $uid, $uid]);
    $nonLues = (int) q1('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND lu = 0', [$uid])['n'];

    json_out(['data' => [
        'compteurs' => $counts + ['notifications_non_lues' => $nonLues],
        'dernieres_reponses' => array_map(fn ($r) => $r + ['auteur' => 'Service RH'], $reponses),
        'recents' => $recents,
    ]]);
});

route('GET', '/me/historique', function () {
    $uid = current_user()['id'];
    $kind = qp('kind');
    $kinds = $kind && in_array($kind, ALL_KINDS, true) ? [$kind] : ALL_KINDS;
    $params = array_fill(0, count($kinds), $uid);

    $where = [];
    $statut = qp('statut');
    if ($statut && in_array($statut, STATUTS, true)) { $where[] = 'statut = ?'; $params[] = $statut; }
    $termines = qp('termines');
    if ($termines === 'true') { $where[] = "statut IN ('RESOLU','CLOTURE')"; }
    if ($termines === 'false') { $where[] = "statut NOT IN ('RESOLU','CLOTURE')"; }

    $rows = q(
        'SELECT * FROM (' . my_tickets_union($kinds) . ') x ' . ($where ? 'WHERE ' . implode(' AND ', $where) : '') .
        ' ORDER BY date_creation DESC LIMIT 500',
        $params,
    );
    json_out(['data' => $rows]);
});

route('GET', '/me/profile', function () {
    $uid = current_user()['id'];
    json_out(['data' => q1(
        'SELECT id, matricule, nom, prenom, email, telephone, service, departement, site, role, derniere_connexion, created_at
         FROM users WHERE id = ?',
        [$uid],
    )]);
});

// Seules les coordonnées sont modifiables par le collaborateur
route('PUT', '/me/profile', function () {
    $uid = current_user()['id'];
    $in = body();
    $email = trim((string) ($in['email'] ?? ''));
    $tel = trim((string) ($in['telephone'] ?? ''));
    validator()
        ->check($email === '' || (filter_var($email, FILTER_VALIDATE_EMAIL) !== false && mb_strlen($email) <= 150), 'email', 'Adresse e-mail invalide')
        ->check(mb_strlen($tel) <= 30 && (bool) preg_match('/^[+0-9 ().-]*$/', $tel), 'telephone', 'Numéro de téléphone invalide')
        ->done();
    try {
        run('UPDATE users SET email = ?, telephone = ? WHERE id = ?', [$email ?: null, $tel ?: null, $uid]);
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict('Cette adresse e-mail est déjà utilisée');
        }
        throw $e;
    }
    audit('PROFIL_MODIFICATION', null, null, ['champs' => ['email', 'telephone']]);
    json_out(['data' => ['email' => $email ?: null, 'telephone' => $tel ?: null]]);
});
