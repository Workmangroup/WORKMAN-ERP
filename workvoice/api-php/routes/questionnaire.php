<?php
declare(strict_types=1);

/*
 * Questionnaire de satisfaction du personnel (GRH-IFD-23).
 * ANONYMAT : questionnaire_reponses ne contient jamais user_id ; la table
 * questionnaire_participations sert uniquement à empêcher les doublons.
 * Aucun résultat n'est publié pour un groupe de moins de SEUIL_ANONYMAT réponses.
 */
const SEUIL_ANONYMAT = 5;
// Score orienté satisfaction : la question à formulation négative est inversée
const SCORE_SQL = 'CASE WHEN q.inverse = 1 THEN 6 - d.note ELSE d.note END';

function indice(mixed $moyenne): ?int
{
    return $moyenne === null ? null : (int) round(((float) $moyenne - 1) / 4 * 100);
}

function active_questions(): array
{
    return q('SELECT id, ordre, texte_fr, texte_ar, inverse FROM questionnaire_questions WHERE actif = 1 ORDER BY ordre');
}

function open_campaign(): ?array
{
    return q1(
        "SELECT id, titre, reference, date_debut, date_fin FROM questionnaire_campagnes
         WHERE statut = 'OUVERTE' AND date_debut <= CURDATE() AND (date_fin IS NULL OR date_fin >= CURDATE())
         ORDER BY date_debut DESC LIMIT 1",
    );
}

function effectif(): int
{
    return (int) q1("SELECT COUNT(*) AS n FROM users WHERE actif = 1 AND role = 'EMPLOYE'")['n'];
}

// ---------------------------------------------------------------- Collaborateur

route('GET', '/questionnaire/actif', function () {
    $user = current_user();
    $campagne = open_campaign();
    if (!$campagne) {
        json_out(['data' => ['campagne' => null, 'questions' => [], 'deja_repondu' => false]]);
    }
    $deja = q1('SELECT 1 AS ok FROM questionnaire_participations WHERE campagne_id = ? AND user_id = ?', [$campagne['id'], $user['id']]);
    json_out(['data' => [
        'campagne' => $campagne,
        'questions' => array_map(fn ($q) => ['inverse' => (bool) $q['inverse']] + $q, active_questions()),
        'deja_repondu' => (bool) $deja,
    ]]);
});

route('POST', '/questionnaire/campagnes/{id}/reponses', function (array $p) {
    $user = current_user();
    $campagneId = (int) $p['id'];
    $campagne = open_campaign();
    if (!$campagne || (int) $campagne['id'] !== $campagneId) {
        throw new HttpError(409, "Ce questionnaire n'est pas ouvert aux réponses", 'CAMPAGNE_FERMEE');
    }

    $in = body();
    $answered = [];
    foreach ((array) ($in['reponses'] ?? []) as $r) {
        $qid = (int) ($r['question_id'] ?? 0);
        $note = (int) ($r['note'] ?? 0);
        if ($qid > 0 && $note >= 1 && $note <= 5) {
            $answered[$qid] = $note;
        }
    }
    $expected = array_map('intval', array_column(active_questions(), 'id'));
    $missing = array_values(array_diff($expected, array_keys($answered)));
    if ($missing || array_diff(array_keys($answered), $expected)) {
        throw new HttpError(422, 'Merci de répondre à toutes les questions', 'QUESTIONNAIRE_INCOMPLET', ['manquantes' => $missing]);
    }
    $commentaire = validator()->text('commentaire', 0, 2000, 'Le commentaire', true)->done()['commentaire'];

    try {
        tx(function (PDO $pdo) use ($campagneId, $user, $answered, $commentaire) {
            run('INSERT INTO questionnaire_participations (campagne_id, user_id, date_participation) VALUES (?, ?, CURDATE())', [$campagneId, $user['id']], $pdo);
            // UUID v4 aléatoire : ne révèle pas l'ordre de soumission
            $b = random_bytes(16);
            $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
            $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
            $id = vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
            run(
                'INSERT INTO questionnaire_reponses (id, campagne_id, service, departement, site, date_soumission, commentaire)
                 VALUES (?, ?, ?, ?, ?, CURDATE(), ?)',
                [$id, $campagneId, $user['service'], $user['departement'], $user['site'], $commentaire],
                $pdo,
            );
            $params = [];
            foreach ($answered as $qid => $note) {
                array_push($params, $id, $qid, $note);
            }
            run('INSERT INTO questionnaire_reponses_detail (reponse_id, question_id, note) VALUES ' . implode(', ', array_fill(0, count($answered), '(?, ?, ?)')), $params, $pdo);
        });
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict('Vous avez déjà répondu à ce questionnaire. Merci !');
        }
        throw $e;
    }
    // Seule la participation est journalisée — jamais l'identifiant de la réponse
    audit('QUESTIONNAIRE_PARTICIPATION', 'questionnaire_campagnes', $campagneId);
    json_out(['data' => ['ok' => true]], 201);
});

// ---------------------------------------------------------------- RH & Direction

route('GET', '/questionnaire/campagnes', function () {
    require_role(ROLE_RH, ROLE_DIRECTION);
    $campagnes = q(
        'SELECT c.id, c.titre, c.reference, c.date_debut, c.date_fin, c.statut, c.created_at,
                (SELECT COUNT(*) FROM questionnaire_reponses r WHERE r.campagne_id = c.id) AS nb_reponses
         FROM questionnaire_campagnes c ORDER BY c.date_debut DESC',
    );
    $moyennes = [];
    foreach (q(
        'SELECT r.campagne_id, AVG(' . SCORE_SQL . ') AS moyenne
         FROM questionnaire_reponses r
         JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
         JOIN questionnaire_questions q ON q.id = d.question_id
         GROUP BY r.campagne_id',
    ) as $m) {
        $moyennes[(int) $m['campagne_id']] = $m['moyenne'];
    }
    $effectif = effectif();
    json_out(['data' => array_map(fn ($c) => $c + [
        'effectif' => $effectif,
        'taux_participation' => $effectif ? (int) round($c['nb_reponses'] / $effectif * 100) : 0,
        'indice_satisfaction' => $c['nb_reponses'] >= SEUIL_ANONYMAT ? indice($moyennes[(int) $c['id']] ?? null) : null,
    ], $campagnes)]);
});

function assert_no_other_open(int $exceptId = 0): void
{
    $other = q1("SELECT titre FROM questionnaire_campagnes WHERE statut = 'OUVERTE' AND id <> ?", [$exceptId]);
    if ($other) {
        throw conflict("La campagne « {$other['titre']} » est déjà ouverte. Clôturez-la d'abord.");
    }
}

function announce_campaign(string $titre): void
{
    notify_role(ROLE_EMPLOYE, [
        'type' => 'QUESTIONNAIRE_OUVERT',
        'titre' => 'Questionnaire de satisfaction',
        'message' => "« $titre » est ouvert. Votre avis compte : 2 minutes, réponses anonymes.",
        'lien' => '/employe/questionnaire/',
    ], null, false);
}

route('POST', '/questionnaire/campagnes', function () {
    $user = require_role(ROLE_RH);
    $v = validator()
        ->text('titre', 3, 150, 'Le titre')
        ->date('date_debut', 'Date de début')
        ->date('date_fin', 'Date de fin', true)
        ->bool('ouvrir');
    $v->check(!$v->get('date_fin') || !$v->get('date_debut') || $v->get('date_fin') >= $v->get('date_debut'), 'date_fin', 'La date de fin doit suivre la date de début');
    $data = $v->done();

    if ($data['ouvrir']) {
        assert_no_other_open();
    }
    run(
        'INSERT INTO questionnaire_campagnes (titre, date_debut, date_fin, statut, created_by) VALUES (?, ?, ?, ?, ?)',
        [$data['titre'], $data['date_debut'], $data['date_fin'], $data['ouvrir'] ? 'OUVERTE' : 'BROUILLON', $user['id']],
    );
    $id = (int) db()->lastInsertId();
    audit('QUESTIONNAIRE_CAMPAGNE_CREATION', 'questionnaire_campagnes', $id);
    if ($data['ouvrir']) {
        announce_campaign($data['titre']);
    }
    json_out(['data' => ['id' => $id]], 201);
});

route('PATCH', '/questionnaire/campagnes/{id}/statut', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    $statut = validator()->enum('statut', ['OUVERTE', 'CLOTUREE'], 'Statut invalide')->done()['statut'];
    $campagne = q1('SELECT id, titre, statut FROM questionnaire_campagnes WHERE id = ?', [$id]) ?? throw not_found('Campagne introuvable');
    if ($statut === 'OUVERTE') {
        assert_no_other_open($id);
    }
    run('UPDATE questionnaire_campagnes SET statut = ? WHERE id = ?', [$statut, $id]);
    audit('QUESTIONNAIRE_CAMPAGNE_STATUT', 'questionnaire_campagnes', $id, ['de' => $campagne['statut'], 'vers' => $statut]);
    if ($statut === 'OUVERTE' && $campagne['statut'] !== 'OUVERTE') {
        announce_campaign($campagne['titre']);
    }
    json_out(['data' => ['statut' => $statut]]);
});

route('GET', '/questionnaire/campagnes/{id}/resultats', function (array $p) {
    require_role(ROLE_RH, ROLE_DIRECTION);
    $id = (int) $p['id'];
    $campagne = q1('SELECT id, titre, reference, date_debut, date_fin, statut FROM questionnaire_campagnes WHERE id = ?', [$id])
        ?? throw not_found('Campagne introuvable');

    $where = ['r.campagne_id = ?'];
    $params = [$id];
    $site = qp('site', 80);
    $dep = qp('departement', 80);
    if ($site) { $where[] = 'r.site = ?'; $params[] = $site; }
    if ($dep) { $where[] = 'r.departement = ?'; $params[] = $dep; }
    $whereSql = implode(' AND ', $where);

    $n = (int) q1("SELECT COUNT(*) AS n FROM questionnaire_reponses r WHERE $whereSql", $params)['n'];
    $effectif = effectif();
    $base = [
        'campagne' => $campagne,
        'seuil' => SEUIL_ANONYMAT,
        'nb_reponses' => $n,
        'effectif' => $effectif,
        'taux_participation' => $effectif && !$site && !$dep ? (int) round($n / $effectif * 100) : null,
    ];
    // Groupe trop petit : rien n'est publié (protection de l'anonymat)
    if ($n < SEUIL_ANONYMAT) {
        json_out(['data' => $base + ['insuffisant' => true]]);
    }

    $dist = [];
    foreach (q(
        "SELECT d.question_id, d.note, COUNT(*) AS total
         FROM questionnaire_reponses r JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
         WHERE $whereSql GROUP BY d.question_id, d.note",
        $params,
    ) as $row) {
        $dist[(int) $row['question_id']][(int) $row['note']] = (int) $row['total'];
    }

    $groups = function (string $col) use ($whereSql, $params) {
        $rows = q(
            "SELECT r.$col AS groupe, COUNT(DISTINCT r.id) AS n, AVG(" . SCORE_SQL . ") AS moyenne
             FROM questionnaire_reponses r
             JOIN questionnaire_reponses_detail d ON d.reponse_id = r.id
             JOIN questionnaire_questions q ON q.id = d.question_id
             WHERE $whereSql GROUP BY r.$col ORDER BY r.$col",
            $params,
        );
        $visible = [];
        $masques = 0;
        foreach ($rows as $g) {
            if ((int) $g['n'] >= SEUIL_ANONYMAT) {
                $visible[] = ['groupe' => $g['groupe'], 'n' => (int) $g['n'], 'indice' => indice($g['moyenne'])];
            } else {
                $masques += (int) $g['n'];
            }
        }
        return ['groupes' => $visible, 'reponses_masquees' => $masques];
    };

    $totalScore = 0.0;
    $totalCount = 0;
    $parQuestion = [];
    foreach (q('SELECT id, ordre, texte_fr, texte_ar, inverse FROM questionnaire_questions ORDER BY ordre') as $qq) {
        $counts = array_map(fn ($note) => $dist[(int) $qq['id']][$note] ?? 0, [1, 2, 3, 4, 5]);
        $total = array_sum($counts);
        if (!$total) {
            continue;
        }
        $moyenne = array_sum(array_map(fn ($c, $i) => $c * ($i + 1), $counts, array_keys($counts))) / $total;
        $inverse = (bool) $qq['inverse'];
        $score = $inverse ? 6 - $moyenne : $moyenne;
        $totalScore += $score * $total;
        $totalCount += $total;
        // « Favorable » = d'accord (4–5), ou pas d'accord (1–2) pour une question négative
        $favorables = $inverse ? $counts[0] + $counts[1] : $counts[3] + $counts[4];
        $parQuestion[] = [
            'question_id' => (int) $qq['id'],
            'ordre' => (int) $qq['ordre'],
            'texte_fr' => $qq['texte_fr'],
            'texte_ar' => $qq['texte_ar'],
            'inverse' => $inverse,
            'repartition' => $counts, // index 0 = note 1 … index 4 = note 5
            'total' => $total,
            'moyenne' => round($moyenne, 2),
            'indice' => indice($score),
            'taux_favorable' => (int) round($favorables / $total * 100),
        ];
    }

    // L'identifiant UUID donne un ordre aléatoire : impossible de déduire l'ordre de dépôt
    $commentaires = array_column(q("SELECT commentaire FROM questionnaire_reponses r WHERE $whereSql AND commentaire IS NOT NULL ORDER BY r.id LIMIT 100", $params), 'commentaire');

    json_out(['data' => $base + [
        'insuffisant' => false,
        'indice_satisfaction' => $totalCount ? indice($totalScore / $totalCount) : null,
        'par_question' => $parQuestion,
        'par_departement' => $groups('departement'),
        'par_site' => $groups('site'),
        'commentaires' => $commentaires,
    ]]);
});

route('GET', '/questionnaire/referentiels', function () {
    require_role(ROLE_RH, ROLE_DIRECTION);
    json_out(['data' => [
        'sites' => array_column(q('SELECT DISTINCT site FROM questionnaire_reponses ORDER BY site'), 'site'),
        'departements' => array_column(q('SELECT DISTINCT departement FROM questionnaire_reponses ORDER BY departement'), 'departement'),
    ]]);
});
