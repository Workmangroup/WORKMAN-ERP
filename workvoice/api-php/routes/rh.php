<?php
declare(strict_types=1);

const OPEN_SQL = "statut NOT IN ('RESOLU','CLOTURE')";
const AVG_DAYS_SQL = 'AVG(TIMESTAMPDIFF(HOUR, date_creation, date_cloture)) / 24';

route('GET', '/rh/dashboard', function () {
    require_role(ROLE_RH);
    $open = OPEN_SQL;
    $avg = AVG_DAYS_SQL;

    $kpi = q1(
        "SELECT
           (SELECT COUNT(*) FROM demandes     WHERE $open) AS demandes_ouvertes,
           (SELECT COUNT(*) FROM reclamations WHERE $open) AS reclamations_ouvertes,
           (SELECT COUNT(*) FROM suggestions  WHERE $open) AS suggestions_ouvertes,
           (SELECT COUNT(*) FROM reclamations WHERE niveau_urgence = 'CRITIQUE' AND $open) AS critiques_ouvertes,
           (SELECT COUNT(*) FROM demandes WHERE statut = 'NOUVEAU')
             + (SELECT COUNT(*) FROM reclamations WHERE statut = 'NOUVEAU')
             + (SELECT COUNT(*) FROM suggestions  WHERE statut = 'NOUVEAU') AS a_prendre_en_charge",
    );
    $kpi = array_map('intval', $kpi);

    $delais = q1(
        "SELECT
           (SELECT $avg FROM demandes     WHERE date_cloture IS NOT NULL) AS demandes,
           (SELECT $avg FROM reclamations WHERE date_cloture IS NOT NULL) AS reclamations,
           (SELECT $avg FROM (
              SELECT date_creation, date_cloture FROM demandes     WHERE date_cloture IS NOT NULL
              UNION ALL
              SELECT date_creation, date_cloture FROM reclamations WHERE date_cloture IS NOT NULL
            ) x) AS global",
    );
    $delais = array_map(fn ($v) => fnum($v), $delais);

    $parStatut = array_map(fn ($r) => [
        'statut' => $r['statut'], 'demandes' => (int) $r['demandes'], 'reclamations' => (int) $r['reclamations'],
    ], q(
        "SELECT statut, SUM(kind = 'demande') AS demandes, SUM(kind = 'reclamation') AS reclamations
         FROM (SELECT 'demande' AS kind, statut FROM demandes UNION ALL SELECT 'reclamation', statut FROM reclamations) x
         GROUP BY statut ORDER BY FIELD(statut, 'NOUVEAU','EN_COURS','EN_ATTENTE','RESOLU','CLOTURE')",
    ));

    $parType = q("SELECT type_demande AS type, COUNT(*) AS total FROM demandes WHERE $open GROUP BY type_demande ORDER BY total DESC");

    $derniers = q(
        "SELECT * FROM (
           SELECT 'demande' AS kind, d.id, d.numero_demande AS numero, d.type_demande AS type, d.objet, d.statut,
                  NULL AS niveau_urgence, d.date_creation, u.nom, u.prenom, u.matricule, u.site
           FROM demandes d JOIN users u ON u.id = d.user_id
           UNION ALL
           SELECT 'reclamation', r.id, r.numero_reclamation, r.categorie, r.objet, r.statut,
                  r.niveau_urgence, r.date_creation, u.nom, u.prenom, u.matricule, u.site
           FROM reclamations r JOIN users u ON u.id = r.user_id
         ) x ORDER BY date_creation DESC LIMIT 8",
    );

    json_out(['data' => [
        'kpi' => $kpi + ['delai_moyen_jours' => $delais['global']],
        'delais_moyens_jours' => $delais,
        'par_statut' => $parStatut,
        'demandes_ouvertes_par_type' => $parType,
        'derniers_tickets' => $derniers,
    ]]);
});

foreach (array_keys(TICKET_KINDS) as $path) {
    route('GET', "/rh/$path", function () use ($path) {
        require_role(ROLE_RH);
        json_out(list_for_rh(kind_cfg($path)));
    });
}

route('GET', '/rh/referentiels', function () {
    require_role(ROLE_RH);
    json_out(['data' => [
        'sites' => array_column(q('SELECT DISTINCT site FROM users ORDER BY site'), 'site'),
        'departements' => array_column(q('SELECT DISTINCT departement FROM users ORDER BY departement'), 'departement'),
        'services' => array_column(q('SELECT DISTINCT service FROM users ORDER BY service'), 'service'),
    ]]);
});
