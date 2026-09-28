<?php
declare(strict_types=1);

/*
 * MODULE 2 — Autorisations de sortie.
 * Workflow : Collaborateur → RH → Validé/Refusé → Notification.
 */

function sortie_link_employe(int $id): string { return "/employe/sorties/?id=$id"; }
function sortie_link_rh(int $id): string { return "/rh/sorties/?id=$id"; }

function load_sortie(int $id): array
{
    return q1(
        'SELECT s.*, m.libelle AS motif_libelle FROM sorties_demandes s JOIN sorties_motifs m ON m.id = s.motif_id WHERE s.id = ?',
        [$id],
    ) ?? throw not_found('Autorisation de sortie introuvable');
}

// ---------------------------------------------------------------- Référentiel

route('GET', '/sorties/motifs', function () {
    current_user();
    json_out(['data' => q('SELECT id, libelle FROM sorties_motifs WHERE actif = 1 ORDER BY ordre, libelle')]);
});

// ---------------------------------------------------------------- Collaborateur

route('GET', '/me/sorties', function () {
    $uid = current_user()['id'];
    $data = q(
        "SELECT s.id, s.numero, s.date_sortie, s.heure_debut, s.heure_fin, s.duree_minutes, s.statut, s.motif_refus, s.date_creation,
                m.libelle AS motif_libelle
         FROM sorties_demandes s JOIN sorties_motifs m ON m.id = s.motif_id
         WHERE s.user_id = ? ORDER BY s.date_creation DESC",
        [$uid],
    );
    $cumulMois = (int) (q1(
        "SELECT COALESCE(SUM(duree_minutes), 0) AS n FROM sorties_demandes
         WHERE user_id = ? AND statut = 'VALIDE' AND date_sortie >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
        [$uid],
    )['n'] ?? 0);
    $cumulAnnee = (int) (q1(
        "SELECT COALESCE(SUM(duree_minutes), 0) AS n FROM sorties_demandes
         WHERE user_id = ? AND statut = 'VALIDE' AND YEAR(date_sortie) = YEAR(CURDATE())",
        [$uid],
    )['n'] ?? 0);
    json_out(['data' => $data, 'cumul_mois_minutes' => $cumulMois, 'cumul_annee_minutes' => $cumulAnnee]);
});

route('GET', '/sorties/{id}', function (array $p) {
    $user = current_user();
    $s = load_sortie((int) $p['id']);
    $isRh = $user['role'] === ROLE_RH;
    if (!$isRh && (int) $s['user_id'] !== (int) $user['id']) {
        throw not_found('Autorisation de sortie introuvable');
    }
    if ($isRh) {
        $s['auteur'] = q1('SELECT ' . IDENTITY_COLS . ', ' . ORGA_COLS . ' FROM users u WHERE u.id = ?', [$s['user_id']]);
    }
    json_out(['data' => $s]);
});

route('POST', '/sorties', function () {
    $user = current_user();
    $in = body();
    $motifId = (int) ($in['motif_id'] ?? 0);
    $v = validator()
        ->date('date_sortie', 'La date')
        ->text('heure_debut', 5, 5, "L'heure de début")
        ->text('heure_fin', 5, 5, "L'heure de fin")
        ->text('commentaire', 0, 2000, 'Le commentaire', true)
        ->done();

    if (!q1('SELECT 1 FROM sorties_motifs WHERE id = ? AND actif = 1', [$motifId])) {
        throw bad_request('Motif invalide');
    }
    if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v['heure_debut']) || !preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v['heure_fin'])) {
        throw bad_request('Heure invalide (format HH:MM)');
    }
    [$h1, $m1] = array_map('intval', explode(':', $v['heure_debut']));
    [$h2, $m2] = array_map('intval', explode(':', $v['heure_fin']));
    $duree = ($h2 * 60 + $m2) - ($h1 * 60 + $m1);
    if ($duree <= 0) {
        throw bad_request("L'heure de fin doit être postérieure à l'heure de début");
    }
    if ($v['date_sortie'] < date('Y-m-d')) {
        throw bad_request('La date ne peut pas être dans le passé');
    }

    $numero = tx(function (PDO $pdo) use ($user, $motifId, $v, $duree) {
        $numero = next_numero($pdo, 'SOR');
        run(
            'INSERT INTO sorties_demandes (numero, user_id, motif_id, date_sortie, heure_debut, heure_fin, duree_minutes, commentaire)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [$numero, $user['id'], $motifId, $v['date_sortie'], $v['heure_debut'], $v['heure_fin'], $duree, $v['commentaire']],
            $pdo,
        );
        return $numero;
    });
    $id = (int) db()->lastInsertId();
    audit('SORTIE_CREATION', 'sorties_demandes', $id, ['numero' => $numero]);
    notify_role(ROLE_RH, [
        'type' => 'NOUVELLE_SORTIE',
        'titre' => "Nouvelle autorisation de sortie $numero",
        'message' => "Le " . formatted_fr_date($v['date_sortie']) . " de {$v['heure_debut']} à {$v['heure_fin']}",
        'lien' => sortie_link_rh($id),
    ], (int) $user['id']);
    json_out(['data' => ['id' => $id, 'numero' => $numero, 'duree_minutes' => $duree]], 201);
});

route('POST', '/sorties/{id}/annuler', function (array $p) {
    $user = current_user();
    $s = load_sortie((int) $p['id']);
    if ((int) $s['user_id'] !== (int) $user['id']) {
        throw not_found('Autorisation de sortie introuvable');
    }
    if ($s['statut'] !== 'EN_ATTENTE') {
        throw conflict('Seule une demande en attente peut être annulée');
    }
    run("UPDATE sorties_demandes SET statut = 'ANNULE' WHERE id = ?", [$s['id']]);
    audit('SORTIE_ANNULATION_COLLABORATEUR', 'sorties_demandes', $s['id']);
    json_out(['data' => ['statut' => 'ANNULE']]);
});

// ---------------------------------------------------------------- RH

route('GET', '/rh/sorties', function () {
    require_role(ROLE_RH);
    $where = [];
    $params = [];
    $statut = qp('statut');
    if ($statut && in_array($statut, ABSENCE_STATUTS, true)) { $where[] = 's.statut = ?'; $params[] = $statut; }
    if ($site = qp('site', 80)) { $where[] = 'u.site = ?'; $params[] = $site; }
    if ($dep = qp('departement', 80)) { $where[] = 'u.departement = ?'; $params[] = $dep; }
    if ($search = qp('q')) {
        $where[] = '(s.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)';
        array_push($params, ...array_fill(0, 4, like($search)));
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $from = "FROM sorties_demandes s JOIN users u ON u.id = s.user_id JOIN sorties_motifs m ON m.id = s.motif_id $whereSql";
    $pg = pagination(20);

    $rows = q(
        "SELECT s.id, s.numero, s.date_sortie, s.heure_debut, s.heure_fin, s.duree_minutes, s.statut, s.date_creation,
                m.libelle AS motif_libelle, u.matricule, u.nom, u.prenom, u.service, u.departement, u.site, u.societe
         $from ORDER BY (s.statut = 'EN_ATTENTE') DESC, s.date_creation DESC LIMIT {$pg['limit']} OFFSET {$pg['offset']}",
        $params,
    );
    $total = (int) q1("SELECT COUNT(*) AS n $from", $params)['n'];
    json_out(paged($rows, $total, $pg));
});

route('PATCH', '/rh/sorties/{id}/statut', function (array $p) {
    $me = require_role(ROLE_RH);
    $s = load_sortie((int) $p['id']);
    $v = validator()->enum('statut', ['VALIDE', 'REFUSE', 'ANNULE'], 'Statut invalide')->text('motif_refus', 0, 500, 'Le motif', true)->done();
    if (!in_array($s['statut'], ['EN_ATTENTE'], true) && $v['statut'] !== 'ANNULE') {
        throw conflict('Seule une demande en attente peut être validée ou refusée');
    }
    run('UPDATE sorties_demandes SET statut = ?, motif_refus = ?, traite_par = ?, date_traitement = NOW() WHERE id = ?', [$v['statut'], $v['motif_refus'], $me['id'], $s['id']]);
    audit('SORTIE_STATUT_CHANGEMENT', 'sorties_demandes', $s['id'], ['de' => $s['statut'], 'vers' => $v['statut']]);
    if ($v['statut'] !== 'ANNULE') {
        $label = LABELS['statut_absence'][$v['statut']];
        notify_users([$s['user_id']], [
            'type' => "SORTIE_{$v['statut']}", 'titre' => "Sortie {$s['numero']} : $label",
            'message' => $v['statut'] === 'REFUSE' && $v['motif_refus'] ? "Motif : {$v['motif_refus']}" : "Votre demande de sortie a été $label.",
            'lien' => sortie_link_employe($s['id']),
        ]);
    }
    json_out(['data' => ['statut' => $v['statut']]]);
});

// ---- Paramétrage : motifs ----
route('GET', '/rh/sorties/motifs', function () {
    require_role(ROLE_RH);
    json_out(['data' => q('SELECT id, libelle, actif, ordre FROM sorties_motifs ORDER BY ordre, libelle')]);
});

route('POST', '/rh/sorties/motifs', function () {
    require_role(ROLE_RH);
    $v = validator()->text('libelle', 2, 100, 'Le libellé')->done();
    try {
        run('INSERT INTO sorties_motifs (libelle, ordre) VALUES (?, 99)', [$v['libelle']]);
    } catch (Throwable $e) {
        if (is_duplicate($e)) { throw conflict('Ce motif existe déjà'); }
        throw $e;
    }
    audit('SORTIE_MOTIF_CREATION', 'sorties_motifs', (int) db()->lastInsertId());
    json_out(['data' => ['id' => (int) db()->lastInsertId()]], 201);
});

route('PATCH', '/rh/sorties/motifs/{id}', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    q1('SELECT id FROM sorties_motifs WHERE id = ?', [$id]) ?? throw not_found('Motif introuvable');
    $v = validator()->text('libelle', 2, 100, 'Le libellé')->bool('actif')->done();
    run('UPDATE sorties_motifs SET libelle = ?, actif = ? WHERE id = ?', [$v['libelle'], $v['actif'] ? 1 : 0, $id]);
    audit('SORTIE_MOTIF_MODIFICATION', 'sorties_motifs', $id);
    json_out(['data' => q1('SELECT id, libelle, actif, ordre FROM sorties_motifs WHERE id = ?', [$id])]);
});

route('DELETE', '/rh/sorties/motifs/{id}', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    $used = q1('SELECT COUNT(*) AS n FROM sorties_demandes WHERE motif_id = ?', [$id]);
    if ((int) $used['n'] > 0) {
        throw conflict('Ce motif est déjà utilisé : le désactiver à la place');
    }
    run('DELETE FROM sorties_motifs WHERE id = ?', [$id]);
    audit('SORTIE_MOTIF_SUPPRESSION', 'sorties_motifs', $id);
    no_content();
});

// ---- Tableau RH ----
route('GET', '/rh/sorties/dashboard', function () {
    require_role(ROLE_RH);
    $kpi = q1(
        "SELECT CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED) AS en_attente,
                CAST(COALESCE(SUM(statut = 'VALIDE'), 0) AS SIGNED) AS validees,
                CAST(COALESCE(SUM(statut = 'REFUSE'), 0) AS SIGNED) AS refusees,
                CAST(COALESCE(SUM(CASE WHEN statut = 'VALIDE' THEN duree_minutes END), 0) AS SIGNED) AS temps_total_minutes
         FROM sorties_demandes",
    );
    $parService = q(
        "SELECT u.service, COUNT(*) AS total, CAST(COALESCE(SUM(s.duree_minutes), 0) AS SIGNED) AS minutes
         FROM sorties_demandes s JOIN users u ON u.id = s.user_id WHERE s.statut = 'VALIDE' GROUP BY u.service ORDER BY minutes DESC",
    );
    $parSociete = q(
        "SELECT COALESCE(u.societe, 'Non renseignée') AS societe, COUNT(*) AS total, CAST(COALESCE(SUM(s.duree_minutes), 0) AS SIGNED) AS minutes
         FROM sorties_demandes s JOIN users u ON u.id = s.user_id WHERE s.statut = 'VALIDE' GROUP BY societe ORDER BY minutes DESC",
    );
    json_out(['data' => ['kpi' => $kpi, 'par_service' => $parService, 'par_societe' => $parSociete]]);
});

// ---- Analyse IA ----
route('GET', '/rh/sorties/analyse', function () {
    require_role(ROLE_RH);
    $alertes = [];

    $frequents = q(
        "SELECT u.nom, u.prenom, u.service, COUNT(*) AS nb
         FROM sorties_demandes s JOIN users u ON u.id = s.user_id
         WHERE s.statut = 'VALIDE' AND s.date_creation >= NOW() - INTERVAL 30 DAY
         GROUP BY s.user_id HAVING nb >= 4 ORDER BY nb DESC LIMIT 20",
    );
    foreach ($frequents as $u) {
        $alertes[] = ['niveau' => 'INFO', 'categorie' => 'UTILISATEUR_FREQUENT', 'message' => "{$u['prenom']} {$u['nom']} ({$u['service']}) : {$u['nb']} sorties validées ce mois-ci"];
    }

    $anormales = q(
        "SELECT s.numero, u.nom, u.prenom, s.duree_minutes FROM sorties_demandes s JOIN users u ON u.id = s.user_id
         WHERE s.statut = 'VALIDE' AND s.duree_minutes > 180 AND s.date_creation >= NOW() - INTERVAL 30 DAY
         ORDER BY s.duree_minutes DESC LIMIT 20",
    );
    foreach ($anormales as $s) {
        $h = intdiv((int) $s['duree_minutes'], 60);
        $m = (int) $s['duree_minutes'] % 60;
        $alertes[] = ['niveau' => 'ATTENTION', 'categorie' => 'DUREE_ANORMALE', 'message' => "{$s['numero']} — {$s['prenom']} {$s['nom']} : durée de {$h} h {$m}"];
    }

    $motifsFrequents = q(
        "SELECT m.libelle, COUNT(*) AS nb FROM sorties_demandes s JOIN sorties_motifs m ON m.id = s.motif_id
         WHERE s.date_creation >= NOW() - INTERVAL 30 DAY GROUP BY m.libelle ORDER BY nb DESC LIMIT 5",
    );

    json_out(['data' => ['alertes' => $alertes, 'motifs_frequents' => $motifsFrequents]]);
});
