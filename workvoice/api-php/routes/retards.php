<?php
declare(strict_types=1);

/*
 * MODULE 3 — Déclaration des retards.
 * Workflow : Collaborateur → RH → Validé/Refusé.
 */

const RETARD_UPLOAD_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'docx', 'zip'];
const RETARD_SEUILS_AUTORISES = [3, 5, 10];

function retard_link_employe(int $id): string { return "/employe/retards/?id=$id"; }
function retard_link_rh(int $id): string { return "/rh/retards/?id=$id"; }

function load_retard(int $id): array
{
    return q1(
        'SELECT r.*, m.libelle AS motif_libelle FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id WHERE r.id = ?',
        [$id],
    ) ?? throw not_found('Déclaration de retard introuvable');
}

function shape_retard(array $r): array
{
    $r['has_piece_jointe'] = !empty($r['piece_jointe']);
    unset($r['piece_jointe']);
    return $r;
}

// ---------------------------------------------------------------- Référentiel

route('GET', '/retards/motifs', function () {
    current_user();
    json_out(['data' => q('SELECT id, libelle FROM retards_motifs WHERE actif = 1 ORDER BY ordre, libelle')]);
});

// ---------------------------------------------------------------- Collaborateur

route('GET', '/me/retards', function () {
    $uid = current_user()['id'];
    json_out(['data' => q(
        "SELECT r.id, r.numero, r.date_retard, r.heure_arrivee, r.statut, r.motif_refus, r.date_creation, m.libelle AS motif_libelle,
                (r.piece_jointe IS NOT NULL) AS has_piece_jointe
         FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id
         WHERE r.user_id = ? ORDER BY r.date_creation DESC",
        [$uid],
    )]);
});

route('GET', '/retards/{id}', function (array $p) {
    $user = current_user();
    $r = load_retard((int) $p['id']);
    $isRh = $user['role'] === ROLE_RH;
    if (!$isRh && (int) $r['user_id'] !== (int) $user['id']) {
        throw not_found('Déclaration de retard introuvable');
    }
    if ($isRh) {
        $r['auteur'] = q1('SELECT ' . IDENTITY_COLS . ', ' . ORGA_COLS . ' FROM users u WHERE u.id = ?', [$r['user_id']]);
    }
    json_out(['data' => shape_retard($r)]);
});

route('POST', '/retards', function () {
    $user = current_user();
    $in = body();
    $motifId = (int) ($in['motif_id'] ?? 0);
    $v = validator()
        ->date('date_retard', 'La date')
        ->text('heure_arrivee', 5, 5, "L'heure d'arrivée")
        ->text('commentaire', 0, 2000, 'Le commentaire', true)
        ->done();

    if (!q1('SELECT 1 FROM retards_motifs WHERE id = ? AND actif = 1', [$motifId])) {
        throw bad_request('Motif invalide');
    }
    if (!preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v['heure_arrivee'])) {
        throw bad_request("Heure d'arrivée invalide (format HH:MM)");
    }
    if ($v['date_retard'] > date('Y-m-d')) {
        throw bad_request('La date ne peut pas être dans le futur');
    }

    $file = store_upload_field('piece_jointe', RETARD_UPLOAD_EXT);
    try {
        $numero = tx(function (PDO $pdo) use ($user, $motifId, $v, $file) {
            $numero = next_numero($pdo, 'RET');
            run(
                'INSERT INTO retards_declarations (numero, user_id, date_retard, heure_arrivee, motif_id, commentaire, piece_jointe, piece_jointe_nom, piece_jointe_mime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$numero, $user['id'], $v['date_retard'], $v['heure_arrivee'], $motifId, $v['commentaire'],
                 $file['piece_jointe'] ?? null, $file['piece_jointe_nom'] ?? null, $file['piece_jointe_mime'] ?? null],
                $pdo,
            );
            return $numero;
        });
    } catch (Throwable $e) {
        if ($file) { @unlink(__DIR__ . '/../uploads/' . $file['piece_jointe']); }
        throw $e;
    }
    $id = (int) db()->lastInsertId();
    audit('RETARD_CREATION', 'retards_declarations', $id, ['numero' => $numero]);
    notify_role(ROLE_RH, [
        'type' => 'NOUVEAU_RETARD',
        'titre' => "Déclaration de retard $numero",
        'message' => 'Le ' . formatted_fr_date($v['date_retard']) . ", arrivée à {$v['heure_arrivee']}",
        'lien' => retard_link_rh($id),
    ], (int) $user['id']);
    json_out(['data' => ['id' => $id, 'numero' => $numero]], 201);
});

route('POST', '/retards/{id}/annuler', function (array $p) {
    $user = current_user();
    $r = load_retard((int) $p['id']);
    if ((int) $r['user_id'] !== (int) $user['id']) {
        throw not_found('Déclaration de retard introuvable');
    }
    if ($r['statut'] !== 'EN_ATTENTE') {
        throw conflict('Seule une déclaration en attente peut être annulée');
    }
    run("UPDATE retards_declarations SET statut = 'ANNULE' WHERE id = ?", [$r['id']]);
    audit('RETARD_ANNULATION_COLLABORATEUR', 'retards_declarations', $r['id']);
    json_out(['data' => ['statut' => 'ANNULE']]);
});

route('GET', '/retards/{id}/piece-jointe', function (array $p) {
    $user = current_user();
    $r = load_retard((int) $p['id']);
    if ($user['role'] !== ROLE_RH && (int) $r['user_id'] !== (int) $user['id']) {
        throw not_found('Déclaration de retard introuvable');
    }
    audit('RETARD_PIECE_JOINTE_TELECHARGEMENT', 'retards_declarations', $r['id']);
    download_stored_file($r['piece_jointe'], $r['piece_jointe_nom'], $r['piece_jointe_mime']);
});

// ---------------------------------------------------------------- RH

route('GET', '/rh/retards', function () {
    require_role(ROLE_RH);
    $where = [];
    $params = [];
    $statut = qp('statut');
    if ($statut && in_array($statut, ABSENCE_STATUTS, true)) { $where[] = 'r.statut = ?'; $params[] = $statut; }
    if ($site = qp('site', 80)) { $where[] = 'u.site = ?'; $params[] = $site; }
    if ($dep = qp('departement', 80)) { $where[] = 'u.departement = ?'; $params[] = $dep; }
    if ($search = qp('q')) {
        $where[] = '(r.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)';
        array_push($params, ...array_fill(0, 4, like($search)));
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $from = "FROM retards_declarations r JOIN users u ON u.id = r.user_id JOIN retards_motifs m ON m.id = r.motif_id $whereSql";
    $pg = pagination(20);

    $rows = q(
        "SELECT r.id, r.numero, r.date_retard, r.heure_arrivee, r.statut, r.date_creation, m.libelle AS motif_libelle,
                u.matricule, u.nom, u.prenom, u.service, u.departement, u.site, (r.piece_jointe IS NOT NULL) AS has_piece_jointe
         $from ORDER BY (r.statut = 'EN_ATTENTE') DESC, r.date_creation DESC LIMIT {$pg['limit']} OFFSET {$pg['offset']}",
        $params,
    );
    $total = (int) q1("SELECT COUNT(*) AS n $from", $params)['n'];
    json_out(paged($rows, $total, $pg));
});

route('PATCH', '/rh/retards/{id}/statut', function (array $p) {
    $me = require_role(ROLE_RH);
    $r = load_retard((int) $p['id']);
    $v = validator()->enum('statut', ['VALIDE', 'REFUSE', 'ANNULE'], 'Statut invalide')->text('motif_refus', 0, 500, 'Le motif', true)->done();
    if ($r['statut'] !== 'EN_ATTENTE' && $v['statut'] !== 'ANNULE') {
        throw conflict('Seule une déclaration en attente peut être validée ou refusée');
    }
    run('UPDATE retards_declarations SET statut = ?, motif_refus = ?, traite_par = ?, date_traitement = NOW() WHERE id = ?', [$v['statut'], $v['motif_refus'], $me['id'], $r['id']]);
    audit('RETARD_STATUT_CHANGEMENT', 'retards_declarations', $r['id'], ['de' => $r['statut'], 'vers' => $v['statut']]);
    if ($v['statut'] !== 'ANNULE') {
        $label = LABELS['statut_absence'][$v['statut']];
        notify_users([$r['user_id']], [
            'type' => "RETARD_{$v['statut']}", 'titre' => "Retard {$r['numero']} : $label",
            'message' => $v['statut'] === 'REFUSE' && $v['motif_refus'] ? "Motif : {$v['motif_refus']}" : "Votre déclaration de retard a été $label.",
            'lien' => retard_link_employe($r['id']),
        ]);
    }
    json_out(['data' => ['statut' => $v['statut']]]);
});

// ---- Paramétrage : motifs ----
route('GET', '/rh/retards/motifs', function () {
    require_role(ROLE_RH);
    json_out(['data' => q('SELECT id, libelle, actif, ordre FROM retards_motifs ORDER BY ordre, libelle')]);
});

route('POST', '/rh/retards/motifs', function () {
    require_role(ROLE_RH);
    $v = validator()->text('libelle', 2, 100, 'Le libellé')->done();
    try {
        run('INSERT INTO retards_motifs (libelle, ordre) VALUES (?, 99)', [$v['libelle']]);
    } catch (Throwable $e) {
        if (is_duplicate($e)) { throw conflict('Ce motif existe déjà'); }
        throw $e;
    }
    audit('RETARD_MOTIF_CREATION', 'retards_motifs', (int) db()->lastInsertId());
    json_out(['data' => ['id' => (int) db()->lastInsertId()]], 201);
});

route('PATCH', '/rh/retards/motifs/{id}', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    q1('SELECT id FROM retards_motifs WHERE id = ?', [$id]) ?? throw not_found('Motif introuvable');
    $v = validator()->text('libelle', 2, 100, 'Le libellé')->bool('actif')->done();
    run('UPDATE retards_motifs SET libelle = ?, actif = ? WHERE id = ?', [$v['libelle'], $v['actif'] ? 1 : 0, $id]);
    audit('RETARD_MOTIF_MODIFICATION', 'retards_motifs', $id);
    json_out(['data' => q1('SELECT id, libelle, actif, ordre FROM retards_motifs WHERE id = ?', [$id])]);
});

route('DELETE', '/rh/retards/motifs/{id}', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    $used = q1('SELECT COUNT(*) AS n FROM retards_declarations WHERE motif_id = ?', [$id]);
    if ((int) $used['n'] > 0) {
        throw conflict('Ce motif est déjà utilisé : le désactiver à la place');
    }
    run('DELETE FROM retards_motifs WHERE id = ?', [$id]);
    audit('RETARD_MOTIF_SUPPRESSION', 'retards_motifs', $id);
    no_content();
});

// ---- Tableau RH ----
route('GET', '/rh/retards/dashboard', function () {
    require_role(ROLE_RH);
    $kpi = q1(
        "SELECT CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED) AS en_attente,
                CAST(COALESCE(SUM(statut = 'VALIDE'), 0) AS SIGNED) AS valides,
                CAST(COALESCE(SUM(statut = 'REFUSE'), 0) AS SIGNED) AS refuses
         FROM retards_declarations",
    );
    $evolutionMensuelle = q(
        "SELECT DATE_FORMAT(date_retard, '%Y-%m') AS mois, COUNT(*) AS total FROM retards_declarations
         WHERE statut = 'VALIDE' AND date_retard >= CURDATE() - INTERVAL 12 MONTH GROUP BY mois ORDER BY mois",
    );
    $parService = q(
        "SELECT u.service, COUNT(*) AS total FROM retards_declarations r JOIN users u ON u.id = r.user_id
         WHERE r.statut = 'VALIDE' GROUP BY u.service ORDER BY total DESC",
    );
    json_out(['data' => ['kpi' => $kpi, 'evolution_mensuelle' => $evolutionMensuelle, 'par_service' => $parService]]);
});

// ---- Analyse IA ----
route('GET', '/rh/retards/analyse', function () {
    require_role(ROLE_RH);
    $seuil = (int) (qp('seuil') ?? 3);
    if (!in_array($seuil, RETARD_SEUILS_AUTORISES, true)) {
        $seuil = 3;
    }

    $topCollaborateurs = q(
        "SELECT u.nom, u.prenom, u.service, COUNT(*) AS nb
         FROM retards_declarations r JOIN users u ON u.id = r.user_id
         WHERE r.statut = 'VALIDE' AND r.date_retard >= CURDATE() - INTERVAL 90 DAY
         GROUP BY r.user_id HAVING nb >= ? ORDER BY nb DESC LIMIT 20",
        [$seuil],
    );
    $parService = q(
        "SELECT u.service, COUNT(*) AS nb FROM retards_declarations r JOIN users u ON u.id = r.user_id
         WHERE r.statut = 'VALIDE' AND r.date_retard >= CURDATE() - INTERVAL 90 DAY GROUP BY u.service ORDER BY nb DESC LIMIT 10",
    );
    $heuresCritiques = q(
        "SELECT HOUR(heure_arrivee) AS heure, COUNT(*) AS nb FROM retards_declarations
         WHERE statut = 'VALIDE' AND date_retard >= CURDATE() - INTERVAL 90 DAY GROUP BY heure ORDER BY nb DESC LIMIT 5",
    );
    $causesRecurrentes = q(
        "SELECT m.libelle, COUNT(*) AS nb FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id
         WHERE r.statut = 'VALIDE' AND r.date_retard >= CURDATE() - INTERVAL 90 DAY GROUP BY m.libelle ORDER BY nb DESC LIMIT 10",
    );
    $evolutionAnnuelle = q(
        "SELECT YEAR(date_retard) AS annee, COUNT(*) AS nb FROM retards_declarations
         WHERE statut = 'VALIDE' GROUP BY annee ORDER BY annee",
    );

    // Évolution par site/mois pour les alertes textuelles type « +25% sur MB Confection »
    $alertes = [];
    foreach ($topCollaborateurs as $u) {
        $alertes[] = ['niveau' => 'ATTENTION', 'categorie' => 'COLLABORATEUR_SEUIL', 'message' => "{$u['prenom']} {$u['nom']} ({$u['service']}) : {$u['nb']} retards sur les 90 derniers jours — seuil de $seuil dépassé"];
    }
    $parMotifTransport = q(
        "SELECT COUNT(*) AS nb FROM retards_declarations r JOIN retards_motifs m ON m.id = r.motif_id
         WHERE r.statut = 'VALIDE' AND m.libelle IN ('Embouteillage', 'Transport public') AND r.date_retard >= DATE_FORMAT(CURDATE(), '%Y-%m-01')",
    );
    if ((int) $parMotifTransport['nb'] >= 5) {
        $alertes[] = ['niveau' => 'INFO', 'categorie' => 'CAUSE_TRANSPORT', 'message' => "{$parMotifTransport['nb']} retards liés au transport ce mois-ci"];
    }

    json_out(['data' => [
        'seuil' => $seuil,
        'top_collaborateurs' => $topCollaborateurs,
        'par_service' => $parService,
        'heures_critiques' => $heuresCritiques,
        'causes_recurrentes' => $causesRecurrentes,
        'evolution_annuelle' => $evolutionAnnuelle,
        'evolution_mensuelle' => q(
            "SELECT DATE_FORMAT(date_retard, '%Y-%m') AS mois, COUNT(*) AS nb FROM retards_declarations
             WHERE statut = 'VALIDE' AND date_retard >= CURDATE() - INTERVAL 12 MONTH GROUP BY mois ORDER BY mois",
        ),
        'alertes' => $alertes,
    ]]);
});
