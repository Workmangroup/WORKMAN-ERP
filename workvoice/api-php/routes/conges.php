<?php
declare(strict_types=1);

/*
 * MODULE 1 — Gestion des congés.
 * Workflow : Collaborateur → RH → Validé/Refusé → Notification.
 * Le solde n'est décompté qu'à la VALIDATION (jamais à la création), et
 * chaque mouvement de solde est historisé dans conges_mouvements.
 */

const CONGE_UPLOAD_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'docx'];
const CONGE_ACTIFS = ['BROUILLON', 'EN_ATTENTE', 'VALIDE'];

// ---------------------------------------------------------------- Utilitaires métier

function conge_types_actifs(): array
{
    return q('SELECT id, code, libelle, deduit_solde, ordre FROM conges_types WHERE actif = 1 ORDER BY ordre, libelle');
}

/** Jours fériés compris dans [debut, fin], au format Y-m-d, pour lookup O(1). */
function jours_feries_set(string $debut, string $fin): array
{
    $rows = q('SELECT date_ferie FROM jours_feries WHERE date_ferie BETWEEN ? AND ?', [$debut, $fin]);
    return array_flip(array_map(fn ($r) => $r['date_ferie'], $rows));
}

/** Nombre de jours ouvrés (hors samedi, dimanche, jours fériés configurés). */
function compute_jours_ouvres(string $debut, string $fin): float
{
    $feries = jours_feries_set($debut, $fin);
    $cursor = new DateTimeImmutable($debut);
    $end = new DateTimeImmutable($fin);
    $n = 0;
    while ($cursor <= $end) {
        $jourSemaine = (int) $cursor->format('N'); // 6 = samedi, 7 = dimanche
        if ($jourSemaine < 6 && !isset($feries[$cursor->format('Y-m-d')])) {
            $n++;
        }
        $cursor = $cursor->modify('+1 day');
    }
    return (float) $n;
}

function conge_overlap_exists(int $userId, string $debut, string $fin, ?int $excludeId = null): bool
{
    $sql = 'SELECT 1 FROM conges_demandes WHERE user_id = ? AND statut IN (' . placeholders(CONGE_ACTIFS) . ')
            AND date_debut <= ? AND date_fin >= ?';
    $params = [$userId, ...CONGE_ACTIFS, $fin, $debut];
    if ($excludeId) {
        $sql .= ' AND id <> ?';
        $params[] = $excludeId;
    }
    return (bool) q1($sql . ' LIMIT 1', $params);
}

function load_conge(int $id): array
{
    return q1(
        "SELECT d.*, t.code AS type_code, t.libelle AS type_libelle, t.deduit_solde
         FROM conges_demandes d JOIN conges_types t ON t.id = d.type_id WHERE d.id = ?",
        [$id],
    ) ?? throw not_found('Demande de congé introuvable');
}

function shape_conge(array $d): array
{
    $d['deduit_solde'] = (bool) $d['deduit_solde'];
    $d['has_piece_jointe'] = !empty($d['piece_jointe']);
    unset($d['piece_jointe']);
    return $d;
}

function conge_link_employe(int $id): string { return "/employe/conges/?id=$id"; }
function conge_link_rh(int $id): string { return "/rh/conges/?id=$id"; }

// ---------------------------------------------------------------- Référentiels (tous rôles connectés)

route('GET', '/conges/types', function () {
    current_user();
    json_out(['data' => conge_types_actifs()]);
});

route('POST', '/conges/calcul-jours', function () {
    current_user();
    $v = validator()->date('date_debut', 'La date de début')->date('date_fin', 'La date de fin')->done();
    if ($v['date_fin'] < $v['date_debut']) {
        throw bad_request('La date de fin doit être postérieure ou égale à la date de début');
    }
    json_out(['data' => ['nb_jours' => compute_jours_ouvres($v['date_debut'], $v['date_fin'])]]);
});

// ---------------------------------------------------------------- Collaborateur

route('GET', '/me/conges', function () {
    $uid = current_user()['id'];
    json_out(['data' => q(
        "SELECT d.id, d.numero, d.date_debut, d.date_fin, d.nb_jours, d.statut, d.motif_refus, d.date_creation, d.date_traitement,
                t.code AS type_code, t.libelle AS type_libelle
         FROM conges_demandes d JOIN conges_types t ON t.id = d.type_id
         WHERE d.user_id = ? ORDER BY d.date_creation DESC",
        [$uid],
    )]);
});

route('GET', '/me/solde-conges', function () {
    $uid = current_user()['id'];
    $user = q1('SELECT solde_conge_initial, solde_conge_actuel FROM users WHERE id = ?', [$uid]);
    $historique = q(
        'SELECT m.id, m.type, m.jours, m.solde_apres, m.commentaire, m.date_creation, d.numero
         FROM conges_mouvements m LEFT JOIN conges_demandes d ON d.id = m.demande_id
         WHERE m.user_id = ? ORDER BY m.date_creation DESC LIMIT 50',
        [$uid],
    );
    json_out(['data' => [
        'solde_initial' => (float) $user['solde_conge_initial'],
        'solde_actuel' => (float) $user['solde_conge_actuel'],
        'historique' => $historique,
    ]]);
});

route('GET', '/conges/{id}', function (array $p) {
    $user = current_user();
    $d = load_conge((int) $p['id']);
    $isRh = $user['role'] === ROLE_RH;
    if (!$isRh && (int) $d['user_id'] !== (int) $user['id']) {
        throw not_found('Demande de congé introuvable');
    }
    if ($isRh) {
        $d['auteur'] = q1('SELECT ' . IDENTITY_COLS . ', ' . ORGA_COLS . ' FROM users u WHERE u.id = ?', [$d['user_id']]);
    }
    json_out(['data' => shape_conge($d)]);
});

route('POST', '/conges', function () {
    $user = current_user();
    $v = validator()
        ->date('date_debut', 'La date de début')
        ->date('date_fin', 'La date de fin')
        ->text('commentaire', 0, 2000, 'Le commentaire', true);
    $typeId = (int) (body()['type_id'] ?? 0);
    $data = $v->done();

    $type = q1('SELECT id, deduit_solde FROM conges_types WHERE id = ? AND actif = 1', [$typeId]);
    if (!$type) {
        throw bad_request('Type de congé invalide');
    }
    if ($data['date_fin'] < $data['date_debut']) {
        throw bad_request('La date de fin doit être postérieure ou égale à la date de début');
    }
    if ($data['date_debut'] < date('Y-m-d')) {
        throw bad_request('La date de début ne peut pas être dans le passé');
    }
    if (conge_overlap_exists((int) $user['id'], $data['date_debut'], $data['date_fin'])) {
        throw conflict('Vous avez déjà une demande de congé sur cette période (chevauchement)');
    }
    $doublon = q1(
        "SELECT 1 FROM conges_demandes WHERE user_id = ? AND type_id = ? AND date_debut = ? AND date_fin = ?
         AND statut IN (" . placeholders(CONGE_ACTIFS) . ') LIMIT 1',
        [$user['id'], $typeId, $data['date_debut'], $data['date_fin'], ...CONGE_ACTIFS],
    );
    if ($doublon) {
        throw conflict('Une demande identique existe déjà');
    }

    $nbJours = compute_jours_ouvres($data['date_debut'], $data['date_fin']);
    if ($nbJours <= 0) {
        throw bad_request('La période sélectionnée ne contient aucun jour ouvré');
    }
    if ($type['deduit_solde'] && $nbJours > (float) $user['solde_conge_actuel'] + 0.001) {
        throw conflict("Solde de congé insuffisant : {$user['solde_conge_actuel']} jour(s) disponible(s) pour $nbJours demandé(s)");
    }

    $file = store_upload_field('piece_jointe', CONGE_UPLOAD_EXT);
    try {
        $numero = tx(function (PDO $pdo) use ($user, $typeId, $data, $nbJours, $file) {
            $numero = next_numero($pdo, 'CNG');
            run(
                'INSERT INTO conges_demandes (numero, user_id, type_id, date_debut, date_fin, nb_jours, commentaire, piece_jointe, piece_jointe_nom, piece_jointe_mime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$numero, $user['id'], $typeId, $data['date_debut'], $data['date_fin'], $nbJours, $data['commentaire'],
                 $file['piece_jointe'] ?? null, $file['piece_jointe_nom'] ?? null, $file['piece_jointe_mime'] ?? null],
                $pdo,
            );
            return $numero;
        });
    } catch (Throwable $e) {
        if ($file) {
            @unlink(__DIR__ . '/../uploads/' . $file['piece_jointe']);
        }
        throw $e;
    }

    $id = (int) db()->lastInsertId();
    audit('CONGE_CREATION', 'conges_demandes', $id, ['numero' => $numero]);
    notify_role(ROLE_RH, [
        'type' => 'NOUVELLE_DEMANDE_CONGE',
        'titre' => "Nouvelle demande de congé $numero",
        'message' => "Demande du " . formatted_fr_date($data['date_debut']) . ' au ' . formatted_fr_date($data['date_fin']) . " ($nbJours j)",
        'lien' => conge_link_rh($id),
    ], (int) $user['id']);
    json_out(['data' => ['id' => $id, 'numero' => $numero, 'nb_jours' => $nbJours]], 201);
});

route('POST', '/conges/{id}/annuler', function (array $p) {
    $user = current_user();
    $d = load_conge((int) $p['id']);
    if ((int) $d['user_id'] !== (int) $user['id']) {
        throw not_found('Demande de congé introuvable');
    }
    if (!in_array($d['statut'], ['BROUILLON', 'EN_ATTENTE'], true)) {
        throw conflict('Seule une demande en attente peut être annulée par le collaborateur');
    }
    run("UPDATE conges_demandes SET statut = 'ANNULE' WHERE id = ?", [$d['id']]);
    audit('CONGE_ANNULATION_COLLABORATEUR', 'conges_demandes', $d['id']);
    notify_role(ROLE_RH, [
        'type' => 'CONGE_ANNULE',
        'titre' => "Demande de congé {$d['numero']} annulée",
        'message' => 'Le collaborateur a annulé sa demande.',
        'lien' => conge_link_rh($d['id']),
    ], (int) $user['id'], false);
    json_out(['data' => ['statut' => 'ANNULE']]);
});

// ---------------------------------------------------------------- RH

route('GET', '/rh/conges', function () {
    require_role(ROLE_RH);
    $where = [];
    $params = [];
    $statut = qp('statut');
    if ($statut && in_array($statut, CONGE_STATUTS, true)) { $where[] = 'd.statut = ?'; $params[] = $statut; }
    if ($typeId = qp('type_id')) { $where[] = 'd.type_id = ?'; $params[] = (int) $typeId; }
    if ($site = qp('site', 80)) { $where[] = 'u.site = ?'; $params[] = $site; }
    if ($dep = qp('departement', 80)) { $where[] = 'u.departement = ?'; $params[] = $dep; }
    if ($search = qp('q')) {
        $where[] = "(d.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)";
        array_push($params, ...array_fill(0, 4, like($search)));
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $from = "FROM conges_demandes d JOIN users u ON u.id = d.user_id JOIN conges_types t ON t.id = d.type_id $whereSql";
    $pg = pagination(20);

    $rows = q(
        "SELECT d.id, d.numero, d.date_debut, d.date_fin, d.nb_jours, d.statut, d.date_creation,
                t.code AS type_code, t.libelle AS type_libelle,
                u.matricule, u.nom, u.prenom, u.service, u.departement, u.site
         $from ORDER BY (d.statut = 'EN_ATTENTE') DESC, d.date_creation DESC LIMIT {$pg['limit']} OFFSET {$pg['offset']}",
        $params,
    );
    $total = (int) q1("SELECT COUNT(*) AS n $from", $params)['n'];
    json_out(paged($rows, $total, $pg));
});

route('PATCH', '/rh/conges/{id}/statut', function (array $p) {
    $me = require_role(ROLE_RH);
    $d = load_conge((int) $p['id']);
    $v = validator()->enum('statut', ['VALIDE', 'REFUSE', 'ANNULE'], 'Statut invalide')
        ->text('motif_refus', 0, 500, 'Le motif', true)->done();
    $statut = $v['statut'];

    if ($statut === 'VALIDE') {
        if (!in_array($d['statut'], ['BROUILLON', 'EN_ATTENTE'], true)) {
            throw conflict('Seule une demande en attente peut être validée');
        }
        $user = q1('SELECT solde_conge_actuel FROM users WHERE id = ?', [$d['user_id']]);
        if ($d['deduit_solde'] && (float) $user['solde_conge_actuel'] < (float) $d['nb_jours'] - 0.001) {
            throw conflict("Solde insuffisant ({$user['solde_conge_actuel']} j disponible(s) pour {$d['nb_jours']} j)");
        }
        tx(function (PDO $pdo) use ($d, $user, $me) {
            run("UPDATE conges_demandes SET statut = 'VALIDE', traite_par = ?, date_traitement = NOW() WHERE id = ?", [$me['id'], $d['id']], $pdo);
            if ($d['deduit_solde']) {
                $nouveauSolde = round((float) $user['solde_conge_actuel'] - (float) $d['nb_jours'], 1);
                run('UPDATE users SET solde_conge_actuel = ? WHERE id = ?', [$nouveauSolde, $d['user_id']], $pdo);
                run(
                    "INSERT INTO conges_mouvements (user_id, demande_id, type, jours, solde_apres, commentaire, created_by) VALUES (?, ?, 'DEDUCTION', ?, ?, ?, ?)",
                    [$d['user_id'], $d['id'], -$d['nb_jours'], $nouveauSolde, "Congé {$d['numero']} validé", $me['id']],
                    $pdo,
                );
            }
        });
        notify_users([$d['user_id']], [
            'type' => 'CONGE_VALIDE', 'titre' => "Congé {$d['numero']} validé",
            'message' => "Votre demande de congé du " . formatted_fr_date($d['date_debut']) . ' au ' . formatted_fr_date($d['date_fin']) . ' a été validée.',
            'lien' => conge_link_employe($d['id']),
        ]);
    } elseif ($statut === 'REFUSE') {
        if (!in_array($d['statut'], ['BROUILLON', 'EN_ATTENTE'], true)) {
            throw conflict('Seule une demande en attente peut être refusée');
        }
        run("UPDATE conges_demandes SET statut = 'REFUSE', motif_refus = ?, traite_par = ?, date_traitement = NOW() WHERE id = ?", [$v['motif_refus'], $me['id'], $d['id']]);
        notify_users([$d['user_id']], [
            'type' => 'CONGE_REFUSE', 'titre' => "Congé {$d['numero']} refusé",
            'message' => $v['motif_refus'] ? "Motif : {$v['motif_refus']}" : 'Votre demande de congé a été refusée.',
            'lien' => conge_link_employe($d['id']),
        ]);
    } else { // ANNULE, à l'initiative du RH (y compris sur une demande déjà validée : crédit du solde)
        if ($d['statut'] === 'ANNULE') {
            throw conflict('Cette demande est déjà annulée');
        }
        tx(function (PDO $pdo) use ($d, $me) {
            run("UPDATE conges_demandes SET statut = 'ANNULE', traite_par = ?, date_traitement = NOW() WHERE id = ?", [$me['id'], $d['id']], $pdo);
            if ($d['statut'] === 'VALIDE' && $d['deduit_solde']) {
                $user = q1('SELECT solde_conge_actuel FROM users WHERE id = ?', [$d['user_id']], $pdo);
                $nouveauSolde = round((float) $user['solde_conge_actuel'] + (float) $d['nb_jours'], 1);
                run('UPDATE users SET solde_conge_actuel = ? WHERE id = ?', [$nouveauSolde, $d['user_id']], $pdo);
                run(
                    "INSERT INTO conges_mouvements (user_id, demande_id, type, jours, solde_apres, commentaire, created_by) VALUES (?, ?, 'ANNULATION', ?, ?, ?, ?)",
                    [$d['user_id'], $d['id'], $d['nb_jours'], $nouveauSolde, "Annulation du congé {$d['numero']} par le RH", $me['id']],
                    $pdo,
                );
            }
        });
        notify_users([$d['user_id']], [
            'type' => 'CONGE_ANNULE_RH', 'titre' => "Congé {$d['numero']} annulé",
            'message' => 'Votre demande de congé a été annulée par le service RH.', 'lien' => conge_link_employe($d['id']),
        ]);
    }
    audit('CONGE_STATUT_CHANGEMENT', 'conges_demandes', $d['id'], ['de' => $d['statut'], 'vers' => $statut]);
    json_out(['data' => ['statut' => $statut]]);
});

route('GET', '/conges/{id}/piece-jointe', function (array $p) {
    $user = current_user();
    $d = load_conge((int) $p['id']);
    if ($user['role'] !== ROLE_RH && (int) $d['user_id'] !== (int) $user['id']) {
        throw not_found('Demande de congé introuvable');
    }
    audit('CONGE_PIECE_JOINTE_TELECHARGEMENT', 'conges_demandes', $d['id']);
    download_stored_file($d['piece_jointe'], $d['piece_jointe_nom'], $d['piece_jointe_mime']);
});

// ---- Ajustement manuel du solde (régularisation RH, historisé) ----
route('POST', '/rh/conges/soldes/{userId}/ajustement', function (array $p) {
    $me = require_role(ROLE_RH);
    $userId = (int) $p['userId'];
    $user = q1('SELECT id, solde_conge_actuel FROM users WHERE id = ?', [$userId]) ?? throw not_found('Collaborateur introuvable');
    $in = body();
    $jours = (float) ($in['jours'] ?? 0);
    $v = validator()->text('commentaire', 3, 255, 'Le commentaire')->done();
    if (abs($jours) < 0.1 || abs($jours) > 365) {
        throw bad_request('Nombre de jours invalide');
    }
    $nouveauSolde = round((float) $user['solde_conge_actuel'] + $jours, 1);
    tx(function (PDO $pdo) use ($userId, $jours, $nouveauSolde, $v, $me) {
        run('UPDATE users SET solde_conge_actuel = ? WHERE id = ?', [$nouveauSolde, $userId], $pdo);
        run(
            "INSERT INTO conges_mouvements (user_id, type, jours, solde_apres, commentaire, created_by) VALUES (?, 'AJUSTEMENT', ?, ?, ?, ?)",
            [$userId, $jours, $nouveauSolde, $v['commentaire'], $me['id']],
            $pdo,
        );
    });
    audit('CONGE_SOLDE_AJUSTEMENT', 'users', $userId, ['jours' => $jours, 'commentaire' => $v['commentaire']]);
    json_out(['data' => ['solde_actuel' => $nouveauSolde]]);
});

route('GET', '/rh/conges/soldes/{userId}/historique', function (array $p) {
    require_role(ROLE_RH);
    $userId = (int) $p['userId'];
    json_out(['data' => q(
        "SELECT m.id, m.type, m.jours, m.solde_apres, m.commentaire, m.date_creation, d.numero
         FROM conges_mouvements m LEFT JOIN conges_demandes d ON d.id = m.demande_id
         WHERE m.user_id = ? ORDER BY m.date_creation DESC",
        [$userId],
    )]);
});

// ---- Paramétrage : types de congé ----
route('GET', '/rh/conges/types', function () {
    require_role(ROLE_RH);
    json_out(['data' => q('SELECT id, code, libelle, deduit_solde, is_systeme, actif, ordre FROM conges_types ORDER BY ordre, libelle')]);
});

route('POST', '/rh/conges/types', function () {
    require_role(ROLE_RH);
    $v = validator()
        ->text('code', 2, 30, 'Le code')
        ->text('libelle', 2, 100, 'Le libellé')
        ->bool('deduit_solde')
        ->done();
    $code = mb_strtoupper(preg_replace('/[^A-Za-z0-9_]/', '_', $v['code']));
    try {
        run('INSERT INTO conges_types (code, libelle, deduit_solde, is_systeme, ordre) VALUES (?, ?, ?, 0, 99)', [$code, $v['libelle'], $v['deduit_solde'] ? 1 : 0]);
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict('Ce code de type existe déjà');
        }
        throw $e;
    }
    audit('CONGE_TYPE_CREATION', 'conges_types', (int) db()->lastInsertId());
    json_out(['data' => ['id' => (int) db()->lastInsertId()]], 201);
});

// Édition complète (le formulaire RH envoie toujours l'état entier du type, jamais un delta)
route('PATCH', '/rh/conges/types/{id}', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    q1('SELECT id FROM conges_types WHERE id = ?', [$id]) ?? throw not_found('Type introuvable');
    $v = validator()->text('libelle', 2, 100, 'Le libellé')->bool('actif')->bool('deduit_solde')->done();
    run('UPDATE conges_types SET libelle = ?, actif = ?, deduit_solde = ? WHERE id = ?', [$v['libelle'], $v['actif'] ? 1 : 0, $v['deduit_solde'] ? 1 : 0, $id]);
    audit('CONGE_TYPE_MODIFICATION', 'conges_types', $id);
    json_out(['data' => q1('SELECT id, code, libelle, deduit_solde, is_systeme, actif, ordre FROM conges_types WHERE id = ?', [$id])]);
});

route('DELETE', '/rh/conges/types/{id}', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    $type = q1('SELECT is_systeme FROM conges_types WHERE id = ?', [$id]) ?? throw not_found('Type introuvable');
    if ((int) $type['is_systeme'] === 1) {
        throw conflict('Ce type standard ne peut pas être supprimé (le désactiver à la place)');
    }
    $used = q1('SELECT COUNT(*) AS n FROM conges_demandes WHERE type_id = ?', [$id]);
    if ((int) $used['n'] > 0) {
        throw conflict('Ce type est déjà utilisé par des demandes existantes : le désactiver à la place');
    }
    run('DELETE FROM conges_types WHERE id = ?', [$id]);
    audit('CONGE_TYPE_SUPPRESSION', 'conges_types', $id);
    no_content();
});

// ---- Paramétrage : jours fériés ----
route('GET', '/rh/conges/jours-feries', function () {
    require_role(ROLE_RH);
    $annee = (int) (qp('annee') ?? date('Y'));
    json_out(['data' => q('SELECT id, date_ferie, libelle FROM jours_feries WHERE YEAR(date_ferie) = ? ORDER BY date_ferie', [$annee])]);
});

route('POST', '/rh/conges/jours-feries', function () {
    require_role(ROLE_RH);
    $v = validator()->date('date_ferie', 'La date')->text('libelle', 2, 150, 'Le libellé')->done();
    try {
        run('INSERT INTO jours_feries (date_ferie, libelle) VALUES (?, ?)', [$v['date_ferie'], $v['libelle']]);
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict('Ce jour férié est déjà configuré');
        }
        throw $e;
    }
    audit('JOUR_FERIE_AJOUT', 'jours_feries', (int) db()->lastInsertId());
    json_out(['data' => ['id' => (int) db()->lastInsertId()]], 201);
});

route('DELETE', '/rh/conges/jours-feries/{id}', function (array $p) {
    require_role(ROLE_RH);
    run('DELETE FROM jours_feries WHERE id = ?', [(int) $p['id']]);
    audit('JOUR_FERIE_SUPPRESSION', 'jours_feries', (int) $p['id']);
    no_content();
});

// ---- Tableau RH ----
route('GET', '/rh/conges/dashboard', function () {
    require_role(ROLE_RH);
    $kpi = q1(
        "SELECT
           CAST(COALESCE(SUM(statut = 'EN_ATTENTE'), 0) AS SIGNED) AS en_attente,
           CAST(COALESCE(SUM(statut = 'VALIDE'), 0) AS SIGNED) AS validees,
           CAST(COALESCE(SUM(statut = 'REFUSE'), 0) AS SIGNED) AS refusees
         FROM conges_demandes",
    );
    $soldes = q(
        "SELECT id, matricule, nom, prenom, service, departement, site, solde_conge_initial, solde_conge_actuel
         FROM users WHERE actif = 1 AND role = 'EMPLOYE' ORDER BY solde_conge_actuel ASC, nom",
    );
    $calendrier = q(
        "SELECT d.id, d.numero, d.date_debut, d.date_fin, u.nom, u.prenom, u.service, u.site, t.libelle AS type_libelle
         FROM conges_demandes d JOIN users u ON u.id = d.user_id JOIN conges_types t ON t.id = d.type_id
         WHERE d.statut = 'VALIDE' AND d.date_fin >= CURDATE() ORDER BY d.date_debut LIMIT 200",
    );
    json_out(['data' => ['kpi' => $kpi, 'soldes' => $soldes, 'calendrier' => $calendrier]]);
});

// ---- Analyse IA (règles statistiques) ----
route('GET', '/rh/conges/analyse', function () {
    require_role(ROLE_RH);
    $alertes = [];

    // Solde faible
    $soldeFaible = q(
        "SELECT matricule, nom, prenom, service, solde_conge_actuel FROM users
         WHERE actif = 1 AND role = 'EMPLOYE' AND solde_conge_actuel < 3 ORDER BY solde_conge_actuel LIMIT 20",
    );
    foreach ($soldeFaible as $u) {
        $alertes[] = ['niveau' => 'ATTENTION', 'categorie' => 'SOLDE_FAIBLE', 'message' => "{$u['prenom']} {$u['nom']} ({$u['service']}) : solde inférieur à 3 jours ({$u['solde_conge_actuel']} j)"];
    }

    // Absences répétitives / congés fréquents (≥ 3 congés validés sur 90 jours)
    $frequents = q(
        "SELECT u.matricule, u.nom, u.prenom, u.service, COUNT(*) AS nb
         FROM conges_demandes d JOIN users u ON u.id = d.user_id
         WHERE d.statut = 'VALIDE' AND d.date_creation >= NOW() - INTERVAL 90 DAY
         GROUP BY d.user_id HAVING nb >= 3 ORDER BY nb DESC LIMIT 20",
    );
    foreach ($frequents as $u) {
        $alertes[] = ['niveau' => 'INFO', 'categorie' => 'ABSENCES_REPETITIVES', 'message' => "{$u['prenom']} {$u['nom']} ({$u['service']}) : {$u['nb']} congés validés sur les 90 derniers jours"];
    }

    // Risque de sous-effectif : chevauchement de congés validés au sein d'un même service
    $souseffectif = q(
        "SELECT service, d1.date_debut, COUNT(DISTINCT d1.user_id) AS nb
         FROM conges_demandes d1 JOIN users u ON u.id = d1.user_id
         JOIN conges_demandes d2 JOIN users u2 ON u2.id = d2.user_id
           ON u2.service = u.service AND d2.statut = 'VALIDE'
           AND d2.date_debut <= d1.date_fin AND d2.date_fin >= d1.date_debut
         WHERE d1.statut = 'VALIDE' AND d1.date_fin >= CURDATE()
         GROUP BY u.service, d1.date_debut HAVING nb >= 3 ORDER BY nb DESC LIMIT 20",
    );
    foreach ($souseffectif as $r) {
        $alertes[] = ['niveau' => 'CRITIQUE', 'categorie' => 'RISQUE_SOUS_EFFECTIF', 'message' => "{$r['nb']} collaborateurs du service {$r['service']} absents simultanément le " . formatted_fr_date($r['date_debut'])];
    }

    json_out(['data' => ['alertes' => $alertes]]);
});

/** Date au format JJ/MM/AAAA pour les messages destinés aux utilisateurs. */
function formatted_fr_date(string $isoDate): string
{
    return (new DateTimeImmutable($isoDate))->format('d/m/Y');
}
