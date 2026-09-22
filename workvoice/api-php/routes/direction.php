<?php
declare(strict_types=1);

/*
 * RÈGLE D'OR : l'espace Direction n'interroge QUE les vues v_direction_*
 * (aucune colonne d'identité) via db_direction().
 */

function qd(string $sql, array $params = []): array { return q($sql, $params, db_direction()); }
function qd1(string $sql, array $params = []): ?array { return q1($sql, $params, db_direction()); }

const DIRECTION_COLS = 'id, numero_reclamation AS numero, categorie, objet, description, niveau_urgence,
  confidentielle, statut, date_creation, date_cloture, service, departement, site';

function shape_direction(array $r): array
{
    $r['confidentielle'] = (bool) $r['confidentielle'];
    $r['service'] ??= 'Non communiqué';
    return $r;
}

route('GET', '/direction/dashboard', function () {
    require_role(ROLE_DIRECTION);
    $open = OPEN_SQL;
    $avg = AVG_DAYS_SQL;
    $moisDebut = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
    $moisPrec = "DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01')";

    $rec = array_map('intval', qd1(
        "SELECT COUNT(*) AS total,
                COALESCE(SUM(date_creation >= $moisDebut), 0) AS ce_mois,
                COALESCE(SUM(date_creation >= $moisPrec AND date_creation < $moisDebut), 0) AS mois_precedent,
                COALESCE(SUM($open), 0) AS ouvertes,
                COALESCE(SUM(niveau_urgence = 'CRITIQUE' AND $open), 0) AS critiques_ouvertes,
                COALESCE(SUM(statut IN ('RESOLU','CLOTURE')), 0) AS traitees
         FROM v_direction_reclamations",
    ));
    $dem = array_map('intval', qd1(
        "SELECT COUNT(*) AS total,
                COALESCE(SUM(date_creation >= $moisDebut), 0) AS ce_mois,
                COALESCE(SUM($open), 0) AS ouvertes
         FROM v_direction_demandes",
    ));
    $temps = array_map(fn ($v) => fnum($v), qd1(
        "SELECT
           (SELECT $avg FROM v_direction_reclamations WHERE date_cloture IS NOT NULL) AS reclamations,
           (SELECT $avg FROM v_direction_demandes     WHERE date_cloture IS NOT NULL) AS demandes,
           (SELECT $avg FROM (
              SELECT date_creation, date_cloture FROM v_direction_reclamations WHERE date_cloture IS NOT NULL
              UNION ALL
              SELECT date_creation, date_cloture FROM v_direction_demandes     WHERE date_cloture IS NOT NULL
            ) x) AS global",
    ));

    json_out(['data' => [
        'kpi' => [
            'total_reclamations' => $rec['total'],
            'total_demandes' => $dem['total'],
            'temps_moyen_traitement_jours' => $temps['global'],
            'reclamations_ce_mois' => $rec['ce_mois'],
            'reclamations_mois_precedent' => $rec['mois_precedent'],
            'reclamations_ouvertes' => $rec['ouvertes'],
            'critiques_ouvertes' => $rec['critiques_ouvertes'],
            'taux_resolution' => $rec['total'] ? (int) round($rec['traitees'] / $rec['total'] * 100) : 0,
        ],
        'temps_moyen_jours' => $temps,
        'demandes' => $dem,
    ]]);
});

route('GET', '/direction/stats', function () {
    require_role(ROLE_DIRECTION);
    $annee = (int) ($_GET['annee'] ?? date('Y'));
    if ($annee < 2020 || $annee > 2100) {
        $annee = (int) date('Y');
    }
    $range = 'date_creation >= ? AND date_creation < ?';
    $p = ["$annee-01-01", ($annee + 1) . '-01-01'];
    $avgClosed = 'AVG(CASE WHEN date_cloture IS NOT NULL THEN TIMESTAMPDIFF(HOUR, date_creation, date_cloture) END) / 24';

    $group = fn (string $col, string $alias, string $order = 'total DESC') => qd(
        "SELECT $col AS $alias, COUNT(*) AS total FROM v_direction_reclamations WHERE $range GROUP BY 1 ORDER BY $order",
        $p,
    );
    $parService = $group("COALESCE(service, 'Non communiqué')", 'service');
    $parCategorie = $group('categorie', 'categorie');
    $parSite = $group('site', 'site');
    $parDepartement = $group('departement', 'departement');
    $parUrgence = $group('niveau_urgence', 'niveau_urgence', "FIELD(niveau_urgence, 'FAIBLE','MOYEN','ELEVE','CRITIQUE')");

    $byMonth = function (string $view) use ($range, $p, $avgClosed) {
        $out = [];
        foreach (qd("SELECT MONTH(date_creation) AS mois, COUNT(*) AS total, $avgClosed AS temps FROM $view WHERE $range GROUP BY mois", $p) as $r) {
            $out[(int) $r['mois']] = $r;
        }
        return $out;
    };
    $rm = $byMonth('v_direction_reclamations');
    $dm = $byMonth('v_direction_demandes');

    // Mois pas encore écoulés : null (et non 0) pour ne pas tracer une fausse chute
    $now = (int) date('Y');
    $moisCourant = (int) date('n');
    $future = fn (int $m) => $annee > $now || ($annee === $now && $m > $moisCourant);

    $evolution = [];
    $temps = [];
    for ($m = 1; $m <= 12; $m++) {
        $evolution[] = [
            'mois' => $m,
            'reclamations' => $future($m) ? null : (int) ($rm[$m]['total'] ?? 0),
            'demandes' => $future($m) ? null : (int) ($dm[$m]['total'] ?? 0),
        ];
        $temps[] = [
            'mois' => $m,
            'reclamations' => fnum($rm[$m]['temps'] ?? null),
            'demandes' => fnum($dm[$m]['temps'] ?? null),
        ];
    }

    json_out(['data' => [
        'annee' => $annee,
        'reclamations_par_service' => $parService,
        'reclamations_par_categorie' => $parCategorie,
        'reclamations_par_site' => $parSite,
        'reclamations_par_departement' => $parDepartement,
        'reclamations_par_urgence' => $parUrgence,
        'evolution_mensuelle' => $evolution,
        'temps_moyen_mensuel' => $temps,
    ]]);
});

route('GET', '/direction/reclamations', function () {
    require_role(ROLE_DIRECTION);
    $where = [];
    $params = [];
    $filters = [
        'categorie' => ['categorie', array_keys(LABELS['categorie'])],
        'urgence' => ['niveau_urgence', NIVEAUX_URGENCE],
        'statut' => ['statut', STATUTS],
    ];
    foreach ($filters as $key => [$col, $allowed]) {
        $v = qp($key);
        if ($v && in_array($v, $allowed, true)) { $where[] = "$col = ?"; $params[] = $v; }
    }
    if ($site = qp('site', 80)) { $where[] = 'site = ?'; $params[] = $site; }
    if ($dep = qp('departement', 80)) { $where[] = 'departement = ?'; $params[] = $dep; }
    if ($search = qp('q')) {
        $where[] = '(numero_reclamation LIKE ? OR objet LIKE ? OR description LIKE ?)';
        array_push($params, like($search), like($search), like($search));
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $pg = pagination(12);

    $rows = qd('SELECT ' . DIRECTION_COLS . " FROM v_direction_reclamations $whereSql
                ORDER BY date_creation DESC LIMIT {$pg['limit']} OFFSET {$pg['offset']}", $params);
    $total = (int) qd1("SELECT COUNT(*) AS n FROM v_direction_reclamations $whereSql", $params)['n'];
    json_out(paged(array_map('shape_direction', $rows), $total, $pg));
});

route('GET', '/direction/reclamations/{id}', function (array $p) {
    require_role(ROLE_DIRECTION);
    $row = qd1('SELECT ' . DIRECTION_COLS . ' FROM v_direction_reclamations WHERE id = ?', [(int) $p['id']]);
    if (!$row) {
        throw not_found('Réclamation introuvable');
    }
    audit('DIRECTION_CONSULTATION', 'reclamations', (int) $row['id']);
    json_out(['data' => shape_direction($row)]);
});

route('GET', '/direction/referentiels', function () {
    require_role(ROLE_DIRECTION);
    json_out(['data' => [
        'sites' => array_column(qd('SELECT DISTINCT site FROM v_direction_reclamations ORDER BY site'), 'site'),
        'departements' => array_column(qd('SELECT DISTINCT departement FROM v_direction_reclamations ORDER BY departement'), 'departement'),
    ]]);
});
