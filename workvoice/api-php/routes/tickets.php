<?php
declare(strict_types=1);

/*
 * Demandes RH, réclamations, suggestions : même cycle de vie.
 * Les noms de tables/colonnes du SQL dynamique viennent UNIQUEMENT de TICKET_KINDS.
 */
const TICKET_KINDS = [
    'demandes' => [
        'kind' => 'demande', 'table' => 'demandes', 'numeroCol' => 'numero_demande', 'typeCol' => 'type_demande',
        'prefixe' => 'DEM', 'fk' => 'demande_id', 'path' => 'demandes', 'label' => 'demande RH', 'labelCap' => 'Demande RH',
    ],
    'reclamations' => [
        'kind' => 'reclamation', 'table' => 'reclamations', 'numeroCol' => 'numero_reclamation', 'typeCol' => 'categorie',
        'prefixe' => 'REC', 'fk' => 'reclamation_id', 'path' => 'reclamations', 'label' => 'réclamation', 'labelCap' => 'Réclamation',
    ],
    'suggestions' => [
        'kind' => 'suggestion', 'table' => 'suggestions', 'numeroCol' => 'numero_suggestion', 'typeCol' => 'theme',
        'prefixe' => 'SUG', 'fk' => 'suggestion_id', 'path' => 'suggestions', 'label' => 'suggestion', 'labelCap' => 'Suggestion',
    ],
];

const IDENTITY_COLS = 'u.matricule, u.nom, u.prenom, u.email, u.telephone';
const ORGA_COLS = 'u.service, u.departement, u.site';

function kind_cfg(string $path): array
{
    return TICKET_KINDS[$path] ?? throw not_found();
}

function kind_types(array $cfg): array
{
    return array_keys(LABELS[$cfg['typeCol']]);
}

function base_cols(array $cfg): string
{
    return "t.*, t.{$cfg['numeroCol']} AS numero, t.{$cfg['typeCol']} AS type";
}

function employee_link(array $cfg, int $id): string { return "/employe/ticket/?kind={$cfg['kind']}&id=$id"; }
function rh_link(array $cfg, int $id): string { return "/rh/ticket/?kind={$cfg['kind']}&id=$id"; }

/** Ticket pour l'API : identité uniquement pour le RH, nom de fichier stocké jamais exposé. */
function shape_ticket(array $cfg, array $row, bool $withIdentity): array
{
    $identity = ['matricule', 'nom', 'prenom', 'email', 'telephone', 'service', 'departement', 'site'];
    $auteur = array_intersect_key($row, array_flip($identity));
    $t = array_diff_key($row, array_flip([...$identity, 'piece_jointe']));
    $t = ['kind' => $cfg['kind']] + $t;
    if (array_key_exists('confidentielle', $t)) {
        $t['confidentielle'] = (bool) $t['confidentielle'];
    }
    if ($cfg['kind'] === 'demande') {
        $t['has_piece_jointe'] = !empty($row['piece_jointe']);
    }
    if ($withIdentity) {
        $t['auteur'] = $auteur;
    }
    return $t;
}

function load_ticket(array $cfg, int $id): array
{
    $row = q1(
        'SELECT ' . base_cols($cfg) . ', ' . IDENTITY_COLS . ', ' . ORGA_COLS . "
         FROM {$cfg['table']} t JOIN users u ON u.id = t.user_id WHERE t.id = ?",
        [$id],
    );
    return $row ?? throw not_found("{$cfg['labelCap']} introuvable");
}

/** RH ou auteur uniquement ; sinon 404 (ne révèle pas l'existence du ticket). */
function load_for_viewer(array $cfg, int $id, array $viewer): array
{
    $row = load_ticket($cfg, $id);
    $isRh = $viewer['role'] === ROLE_RH;
    if (!$isRh && (int) $row['user_id'] !== (int) $viewer['id']) {
        throw not_found("{$cfg['labelCap']} introuvable");
    }
    return [$row, $isRh];
}

function load_comments(array $cfg, int $ticketId, array $viewer): array
{
    $rows = q(
        "SELECT c.id, c.message, c.date_creation, c.user_id, u.role, u.prenom, u.nom
         FROM commentaires c JOIN users u ON u.id = c.user_id
         WHERE c.{$cfg['fk']} = ? ORDER BY c.date_creation, c.id",
        [$ticketId],
    );
    $viewerIsRh = $viewer['role'] === ROLE_RH;
    return array_map(fn ($c) => [
        'id' => $c['id'],
        'message' => $c['message'],
        'date_creation' => $c['date_creation'],
        'est_moi' => (int) $c['user_id'] === (int) $viewer['id'],
        'auteur' => [
            'role' => $c['role'],
            // Côté collaborateur, les réponses RH sont signées « Service RH »
            'nom' => $c['role'] === ROLE_RH && !$viewerIsRh ? 'Service RH' : "{$c['prenom']} {$c['nom']}",
        ],
    ], $rows);
}

function create_ticket(array $cfg, array $user, array $data): array
{
    [$id, $numero] = tx(function (PDO $pdo) use ($cfg, $user, $data) {
        $numero = next_numero($pdo, $cfg['prefixe']);
        $cols = [...array_keys($data), $cfg['numeroCol'], 'user_id'];
        $vals = [...array_values($data), $numero, $user['id']];
        run(
            "INSERT INTO {$cfg['table']} (" . implode(', ', $cols) . ') VALUES (' . placeholders($vals) . ')',
            $vals,
            $pdo,
        );
        return [(int) $pdo->lastInsertId(), $numero];
    });

    $typeLabel = LABELS[$cfg['typeCol']][$data[$cfg['typeCol']]] ?? '';
    $critique = ($data['niveau_urgence'] ?? '') === 'CRITIQUE';
    notify_role(ROLE_RH, [
        'type' => 'NOUVELLE_' . strtoupper($cfg['kind']),
        'titre' => ($critique ? 'CRITIQUE — ' : '') . "Nouvelle {$cfg['label']} $numero",
        'message' => "$typeLabel — {$data['objet']}",
        'lien' => rh_link($cfg, $id),
    ], (int) $user['id']);

    return ['id' => $id, 'numero' => $numero];
}

// ---------------------------------------------------------------- Création

/** Enregistre la pièce jointe d'une demande (contrôles taille, extension, type réel). */
function store_upload(): ?array
{
    $f = $_FILES['piece_jointe'] ?? null;
    if (!$f || ($f['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    $max = (int) CFG['upload_max_mb'] * 1024 * 1024;
    if (in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) || $f['size'] > $max) {
        throw new HttpError(400, 'Fichier trop volumineux (max ' . CFG['upload_max_mb'] . ' Mo)', 'UPLOAD_ERROR');
    }
    if ($f['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) {
        throw new HttpError(400, 'Fichier invalide', 'UPLOAD_ERROR');
    }
    $ext = strtolower(pathinfo((string) $f['name'], PATHINFO_EXTENSION));
    $mime = (new finfo(FILEINFO_MIME_TYPE))->file($f['tmp_name']) ?: '';
    if (!isset(ALLOWED_UPLOADS[$ext]) || !in_array($mime, ALLOWED_UPLOADS[$ext], true)) {
        throw new HttpError(400, 'Type de fichier non autorisé (PDF, JPG, PNG, DOC, DOCX uniquement)', 'UPLOAD_ERROR');
    }
    $dir = __DIR__ . '/../uploads';
    // Nom aléatoire : jamais de nom fourni par l'utilisateur sur le disque
    $stored = bin2hex(random_bytes(16)) . '.' . $ext;
    if (!move_uploaded_file($f['tmp_name'], "$dir/$stored")) {
        throw new RuntimeException("Impossible d'enregistrer la pièce jointe (droits du dossier uploads ?)");
    }
    return [
        'piece_jointe' => $stored,
        'piece_jointe_nom' => mb_substr(basename((string) $f['name']), 0, 255),
        'piece_jointe_mime' => $mime,
    ];
}

route('POST', '/demandes', function () {
    $user = current_user();
    $cfg = kind_cfg('demandes');
    $data = validator()
        ->enum('type_demande', kind_types($cfg), 'Type de demande invalide')
        ->text('objet', 3, 150, "L'objet")
        ->text('description', 10, 5000, 'La description')
        ->done();

    $file = store_upload();
    try {
        $created = create_ticket($cfg, $user, $data + ($file ?? []));
    } catch (Throwable $e) {
        if ($file) {
            @unlink(__DIR__ . '/../uploads/' . $file['piece_jointe']);
        }
        throw $e;
    }
    audit('DEMANDE_CREATION', 'demandes', $created['id'], ['numero' => $created['numero']]);
    json_out(['data' => $created], 201);
});

route('POST', '/reclamations', function () {
    $user = current_user();
    $cfg = kind_cfg('reclamations');
    $data = validator()
        ->enum('categorie', kind_types($cfg), 'Catégorie invalide')
        ->text('objet', 3, 150, "L'objet")
        ->text('description', 20, 5000, 'La description')
        ->enum('niveau_urgence', NIVEAUX_URGENCE, "Niveau d'urgence invalide", 'MOYEN')
        ->bool('confidentielle')
        ->done();
    // Le harcèlement est toujours confidentiel
    $data['confidentielle'] = ($data['confidentielle'] || $data['categorie'] === 'HARCELEMENT') ? 1 : 0;

    $created = create_ticket($cfg, $user, $data);
    audit('RECLAMATION_CREATION', 'reclamations', $created['id'], [
        'numero' => $created['numero'], 'urgence' => $data['niveau_urgence'], 'confidentielle' => (bool) $data['confidentielle'],
    ]);

    // Réclamation critique : alerte Direction strictement anonymisée
    if ($data['niveau_urgence'] === 'CRITIQUE') {
        $orga = $data['confidentielle']
            ? "Département {$user['departement']} · Site {$user['site']}"
            : "Service {$user['service']} · Département {$user['departement']} · Site {$user['site']}";
        notify_role(ROLE_DIRECTION, [
            'type' => 'RECLAMATION_CRITIQUE',
            'titre' => "Réclamation critique {$created['numero']}",
            'message' => LABELS['categorie'][$data['categorie']] . " — $orga",
            'lien' => "/direction/reclamation/?id={$created['id']}",
        ]);
    }
    json_out(['data' => $created], 201);
});

route('POST', '/suggestions', function () {
    $user = current_user();
    $cfg = kind_cfg('suggestions');
    $data = validator()
        ->enum('theme', kind_types($cfg), 'Thème invalide', 'AUTRE')
        ->text('objet', 3, 150, "L'objet")
        ->text('description', 10, 5000, 'La description')
        ->done();
    $created = create_ticket($cfg, $user, $data);
    audit('SUGGESTION_CREATION', 'suggestions', $created['id'], ['numero' => $created['numero']]);
    json_out(['data' => $created], 201);
});

// ---------------------------------------------------------------- Routes communes

route('GET', '/{kind}/mine', function (array $p) {
    $user = current_user();
    $cfg = kind_cfg($p['kind']);
    $rows = q(
        "SELECT t.id, t.{$cfg['numeroCol']} AS numero, t.{$cfg['typeCol']} AS type, t.objet, t.statut,
                t.date_creation, t.date_maj, t.date_cloture,
                (SELECT COUNT(*) FROM commentaires c WHERE c.{$cfg['fk']} = t.id) AS nb_commentaires
         FROM {$cfg['table']} t WHERE t.user_id = ? ORDER BY t.date_creation DESC",
        [$user['id']],
    );
    json_out(['data' => $rows]);
});

route('GET', '/{kind}/{id}', function (array $p) {
    $user = current_user();
    $cfg = kind_cfg($p['kind']);
    $id = (int) $p['id'];
    [$row, $isRh] = load_for_viewer($cfg, $id, $user);
    $ticket = shape_ticket($cfg, $row, $isRh);
    $ticket['commentaires'] = load_comments($cfg, $id, $user);
    if ($isRh && (int) $row['user_id'] !== (int) $user['id']) {
        audit('CONSULTATION_IDENTITE', $cfg['table'], $id);
    }
    json_out(['data' => $ticket]);
});

route('POST', '/{kind}/{id}/commentaires', function (array $p) {
    $user = current_user();
    $cfg = kind_cfg($p['kind']);
    $id = (int) $p['id'];
    $message = validator()->text('message', 1, 3000, 'Le message')->done()['message'];
    [$row, $isRh] = load_for_viewer($cfg, $id, $user);

    if (!$isRh && $row['statut'] === 'CLOTURE') {
        throw conflict('Ce dossier est clôturé : il ne peut plus recevoir de message');
    }
    $takeCharge = $isRh && $row['statut'] === 'NOUVEAU';
    $commentId = tx(function (PDO $pdo) use ($cfg, $id, $user, $message, $takeCharge) {
        run("INSERT INTO commentaires ({$cfg['fk']}, user_id, message) VALUES (?, ?, ?)", [$id, $user['id'], $message], $pdo);
        $cid = (int) $pdo->lastInsertId();
        // Une première réponse RH prend le dossier en charge
        if ($takeCharge) {
            run("UPDATE {$cfg['table']} SET statut = 'EN_COURS' WHERE id = ?", [$id], $pdo);
        }
        return $cid;
    });

    if ($isRh && (int) $row['user_id'] !== (int) $user['id']) {
        notify_users([$row['user_id']], [
            'type' => 'REPONSE_RH',
            'titre' => "Nouvelle réponse sur {$row['numero']}",
            'message' => "Le service RH a répondu à votre {$cfg['label']} « {$row['objet']} ».",
            'lien' => employee_link($cfg, $id),
        ]);
    } else {
        notify_role(ROLE_RH, [
            'type' => 'REPONSE_COLLABORATEUR',
            'titre' => "Nouveau message sur {$row['numero']}",
            'message' => "Le collaborateur a ajouté un message à la {$cfg['label']} « {$row['objet']} ».",
            'lien' => rh_link($cfg, $id),
        ], (int) $user['id'], false);
    }
    audit('COMMENTAIRE_AJOUT', $cfg['table'], $id, ['commentaire_id' => $commentId]);
    json_out(['data' => ['id' => $commentId, 'statut' => $takeCharge ? 'EN_COURS' : $row['statut']]], 201);
});

route('PATCH', '/{kind}/{id}/statut', function (array $p) {
    $user = require_role(ROLE_RH);
    $cfg = kind_cfg($p['kind']);
    $id = (int) $p['id'];
    $v = validator()->enum('statut', STATUTS, 'Statut invalide')->text('commentaire', 0, 3000, 'Le commentaire', true)->done();
    $row = load_ticket($cfg, $id);
    $previous = $row['statut'];
    $statut = $v['statut'];
    $termine = in_array($statut, STATUTS_TERMINES, true);

    tx(function (PDO $pdo) use ($cfg, $id, $user, $statut, $termine, $v) {
        run(
            "UPDATE {$cfg['table']} SET statut = ?, date_cloture = " . ($termine ? 'COALESCE(date_cloture, NOW())' : 'NULL') . ' WHERE id = ?',
            [$statut, $id],
            $pdo,
        );
        if ($v['commentaire']) {
            run("INSERT INTO commentaires ({$cfg['fk']}, user_id, message) VALUES (?, ?, ?)", [$id, $user['id'], $v['commentaire']], $pdo);
        }
    });

    if ($previous !== $statut && (int) $row['user_id'] !== (int) $user['id']) {
        $label = LABELS['statut'][$statut];
        notify_users([$row['user_id']], [
            'type' => 'STATUT_MAJ',
            'titre' => "{$row['numero']} : $label",
            'message' => "Votre {$cfg['label']} « {$row['objet']} » est passée au statut « $label ».",
            'lien' => employee_link($cfg, $id),
        ]);
    }
    audit('STATUT_CHANGEMENT', $cfg['table'], $id, ['de' => $previous, 'vers' => $statut]);
    json_out(['data' => ['previous' => $previous, 'statut' => $statut]]);
});

route('GET', '/demandes/{id}/piece-jointe', function (array $p) {
    $user = current_user();
    $cfg = kind_cfg('demandes');
    $id = (int) $p['id'];
    [$row] = load_for_viewer($cfg, $id, $user);
    if (empty($row['piece_jointe'])) {
        throw not_found('Aucune pièce jointe');
    }
    // basename : aucune traversée de répertoire possible
    $path = __DIR__ . '/../uploads/' . basename($row['piece_jointe']);
    if (!is_file($path)) {
        throw not_found('Fichier introuvable sur le serveur');
    }
    audit('PIECE_JOINTE_TELECHARGEMENT', 'demandes', $id);
    $name = $row['piece_jointe_nom'] ?: 'piece-jointe';
    header('Content-Type: ' . ($row['piece_jointe_mime'] ?: 'application/octet-stream'));
    header('Content-Length: ' . filesize($path));
    header("Content-Disposition: attachment; filename=\"" . preg_replace('/[^A-Za-z0-9._-]/', '_', $name) . "\"; filename*=UTF-8''" . rawurlencode($name));
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
});

// ---------------------------------------------------------------- Liste RH

function list_for_rh(array $cfg): array
{
    $where = [];
    $params = [];
    $statut = qp('statut');
    if ($statut && in_array($statut, STATUTS, true)) { $where[] = 't.statut = ?'; $params[] = $statut; }
    if (in_array(qp('ouverts'), ['true', '1'], true)) { $where[] = "t.statut NOT IN ('RESOLU','CLOTURE')"; }
    $type = qp('type');
    if ($type && in_array($type, kind_types($cfg), true)) { $where[] = "t.{$cfg['typeCol']} = ?"; $params[] = $type; }
    $urgence = qp('urgence');
    if ($cfg['kind'] === 'reclamation' && $urgence && in_array($urgence, NIVEAUX_URGENCE, true)) { $where[] = 't.niveau_urgence = ?'; $params[] = $urgence; }
    if ($site = qp('site', 80)) { $where[] = 'u.site = ?'; $params[] = $site; }
    if ($dep = qp('departement', 80)) { $where[] = 'u.departement = ?'; $params[] = $dep; }
    if ($search = qp('q')) {
        $where[] = "(t.{$cfg['numeroCol']} LIKE ? OR t.objet LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)";
        array_push($params, ...array_fill(0, 5, like($search)));
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $from = "FROM {$cfg['table']} t JOIN users u ON u.id = t.user_id $whereSql";
    $pg = pagination(20);
    // Réclamations : les critiques non traitées remontent en premier
    $order = $cfg['kind'] === 'reclamation'
        ? "ORDER BY (t.niveau_urgence = 'CRITIQUE' AND t.statut NOT IN ('RESOLU','CLOTURE')) DESC, t.date_creation DESC"
        : 'ORDER BY t.date_creation DESC';

    $rows = q(
        'SELECT ' . base_cols($cfg) . ', ' . IDENTITY_COLS . ', ' . ORGA_COLS . ",
                (SELECT COUNT(*) FROM commentaires c WHERE c.{$cfg['fk']} = t.id) AS nb_commentaires
         $from $order LIMIT {$pg['limit']} OFFSET {$pg['offset']}",
        $params,
    );
    $total = (int) q1("SELECT COUNT(*) AS n $from", $params)['n'];
    return paged(array_map(fn ($r) => shape_ticket($cfg, $r, true), $rows), $total, $pg);
}
