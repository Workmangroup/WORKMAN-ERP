<?php
declare(strict_types=1);

/*
 * Module Attestations RH — workflow dédié et sécurisé, distinct des
 * demandes RH génériques (voir AUDIT_ATTESTATIONS_COFFRE_FORT_CEO.md).
 *
 * RÈGLE ABSOLUE : le collaborateur ne peut JAMAIS télécharger, prévisualiser
 * ni obtenir l'URL du document généré, quelle que soit la situation. Seules
 * les routes /rh/attestations/* y donnent accès, et uniquement pour un RH de
 * la même société ou un SYSTEM_ADMIN (voir can_download_hr_document()).
 */

function next_attestation_numero(PDO $pdo, string $companyCode): string
{
    $annee = (int) date('Y');
    run(
        "INSERT INTO sequences (prefixe, annee, dernier) VALUES ('ATT', ?, LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE dernier = LAST_INSERT_ID(dernier + 1)",
        [$annee],
        $pdo,
    );
    $n = (int) $pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn();
    return sprintf('ATT-%s-%d-%06d', $companyCode, $annee, $n);
}

function load_attestation(int $id): array
{
    return q1('SELECT * FROM attestation_requests WHERE id = ?', [$id]) ?? throw not_found('Attestation introuvable');
}

/** IDOR : un RH_SOCIETE ne peut agir que sur les attestations de sa propre société. */
function require_attestation_scope(array $me, array $row): void
{
    if ($me['role'] === ROLE_RH && (int) $row['company_id'] !== (int) $me['company_id']) {
        throw forbidden();
    }
}

/** Vue collaborateur : statut uniquement, jamais de référence au document ni à son stockage. */
function shape_attestation_employe(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'numero' => $row['numero'],
        'type' => $row['type'],
        'type_libelle' => LABELS['type_demande'][$row['type']] ?? $row['type'],
        'statut' => $row['status'],
        'statut_libelle' => LABELS['attestation_statut'][$row['status']] ?? $row['status'],
        'commentaire' => $row['commentaire'],
        'rejection_reason' => $row['status'] === 'REJECTED' ? $row['rejection_reason'] : null,
        'date_creation' => $row['date_creation'],
        'date_maj' => $row['date_maj'],
    ];
}

function shape_attestation_rh(array $row): array
{
    return shape_attestation_employe($row) + [
        'company_id' => (int) $row['company_id'],
        'version' => (int) $row['version'],
        'document_id' => $row['document_id'] !== null ? (int) $row['document_id'] : null,
        'matricule' => $row['matricule'] ?? $row['snapshot_matricule'],
        'nom' => $row['nom'] ?? $row['snapshot_nom'],
        'prenom' => $row['prenom'] ?? $row['snapshot_prenom'],
        'service' => $row['service'] ?? null,
        'departement' => $row['departement'] ?? null,
        'site' => $row['site'] ?? null,
        'company_name' => $row['company_name'] ?? null,
    ];
}

// ---------------------------------------------------------------- Collaborateur

route('POST', '/me/attestations', function () {
    $user = current_user();
    if ($user['company_id'] === null) {
        throw conflict('Votre compte ne peut pas demander d\'attestation (aucune société associée)');
    }
    $data = validator()
        ->enum('type', ATTESTATION_TYPES, 'Type d\'attestation invalide')
        ->text('commentaire', 0, 1000, 'Le commentaire', true)
        ->done();

    $me = q1('SELECT fonction, date_embauche FROM users WHERE id = ?', [$user['id']]);
    $company = q1('SELECT company_code FROM companies WHERE id = ?', [$user['company_id']]);

    [$id, $numero] = tx(function (PDO $pdo) use ($user, $data, $me, $company) {
        $numero = next_attestation_numero($pdo, $company['company_code']);
        run(
            'INSERT INTO attestation_requests
               (numero, company_id, employee_id, requested_by, type, status,
                snapshot_nom, snapshot_prenom, snapshot_matricule, snapshot_fonction, snapshot_date_embauche, commentaire)
             VALUES (?, ?, ?, ?, ?, \'SUBMITTED\', ?, ?, ?, ?, ?, ?)',
            [
                $numero, $user['company_id'], $user['id'], $user['id'], $data['type'],
                $user['nom'], $user['prenom'], $user['matricule'], $me['fonction'], $me['date_embauche'], $data['commentaire'],
            ],
            $pdo,
        );
        return [(int) $pdo->lastInsertId(), $numero];
    });

    audit('ATTESTATION_DEMANDE', 'attestation_requests', $id, ['numero' => $numero, 'type' => $data['type']]);
    notify_role(ROLE_RH, [
        'type' => 'NOUVELLE_ATTESTATION',
        'titre' => "Nouvelle demande d'attestation $numero",
        'message' => LABELS['type_demande'][$data['type']] . ' — ' . $user['prenom'] . ' ' . $user['nom'],
        'lien' => '/rh/attestations/?id=' . $id,
    ], (int) $user['id']);

    json_out(['data' => ['id' => $id, 'numero' => $numero]], 201);
});

route('GET', '/me/attestations', function () {
    $user = current_user();
    $rows = q('SELECT * FROM attestation_requests WHERE employee_id = ? ORDER BY date_creation DESC', [$user['id']]);
    json_out(['data' => array_map('shape_attestation_employe', $rows)]);
});

// ---------------------------------------------------------------- RH

route('GET', '/rh/attestations', function () {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $where = [];
    $params = [];
    if ($me['role'] === ROLE_RH) {
        $where[] = 'a.company_id = ?';
        $params[] = (int) $me['company_id'];
    } elseif ($cid = qp('company_id')) {
        $where[] = 'a.company_id = ?';
        $params[] = (int) $cid;
    }
    $statut = qp('statut');
    if ($statut && in_array($statut, ATTESTATION_STATUTS, true)) { $where[] = 'a.status = ?'; $params[] = $statut; }
    $type = qp('type');
    if ($type && in_array($type, ATTESTATION_TYPES, true)) { $where[] = 'a.type = ?'; $params[] = $type; }
    if ($dep = qp('departement', 80)) { $where[] = 'u.departement = ?'; $params[] = $dep; }
    if ($search = qp('q')) {
        $where[] = '(a.numero LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)';
        array_push($params, ...array_fill(0, 4, like($search)));
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $pg = pagination(20);

    $rows = q(
        "SELECT a.*, u.matricule, u.nom, u.prenom, u.service, u.departement, u.site, c.company_name
         FROM attestation_requests a
         JOIN users u ON u.id = a.employee_id
         JOIN companies c ON c.id = a.company_id
         $whereSql ORDER BY a.date_creation DESC LIMIT {$pg['limit']} OFFSET {$pg['offset']}",
        $params,
    );
    $total = (int) q1("SELECT COUNT(*) AS n FROM attestation_requests a JOIN users u ON u.id = a.employee_id $whereSql", $params)['n'];
    json_out(paged(array_map('shape_attestation_rh', $rows), $total, $pg));
});

route('GET', '/rh/attestations/{id}', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    // « Voir la demande » : prend en charge une demande tout juste soumise
    if ($row['status'] === 'SUBMITTED') {
        run("UPDATE attestation_requests SET status = 'IN_REVIEW' WHERE id = ?", [$id]);
        $row['status'] = 'IN_REVIEW';
    }
    $full = q1(
        'SELECT a.*, u.matricule, u.nom, u.prenom, u.service, u.departement, u.site, c.company_name
         FROM attestation_requests a JOIN users u ON u.id = a.employee_id JOIN companies c ON c.id = a.company_id WHERE a.id = ?',
        [$id],
    );
    json_out(['data' => shape_attestation_rh($full)]);
});

route('POST', '/rh/attestations/{id}/generer', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    if (!in_array($row['status'], ['SUBMITTED', 'IN_REVIEW'], true)) {
        throw conflict('Cette demande a déjà été traitée');
    }
    $company = q1('SELECT company_name, legal_name, address, city FROM companies WHERE id = ?', [$row['company_id']]);
    $pdfBytes = generate_attestation_pdf($company, $row);
    $file = store_hr_document_bytes($pdfBytes);

    tx(function (PDO $pdo) use ($row, $file, $me) {
        run(
            "INSERT INTO hr_documents (company_id, employee_id, category, document_number, uploaded_by)
             VALUES (?, ?, ?, ?, ?)",
            [$row['company_id'], $row['employee_id'], $row['type'], $row['numero'], $me['id']],
            $pdo,
        );
        $documentId = (int) $pdo->lastInsertId();
        run(
            'INSERT INTO hr_document_versions (document_id, version, storage_key, file_name, file_size, checksum, created_by)
             VALUES (?, 1, ?, ?, ?, ?, ?)',
            [$documentId, $file['storage_key'], $row['numero'] . '.pdf', $file['file_size'], $file['checksum'], $me['id']],
            $pdo,
        );
        run("UPDATE attestation_requests SET status = 'GENERATED', document_id = ?, processed_by = ?, processed_at = NOW() WHERE id = ?", [$documentId, $me['id'], $row['id']], $pdo);
    });

    audit('GENERATE_DOCUMENT', 'attestation_requests', $id, ['numero' => $row['numero']]);
    json_out(['data' => ['statut' => 'GENERATED']]);
});

route('POST', '/rh/attestations/{id}/approuver', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    if ($row['status'] !== 'GENERATED') {
        throw conflict('Le document doit être généré avant d\'être validé');
    }
    run("UPDATE attestation_requests SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?", [$me['id'], $id]);
    audit('APPROVE_DOCUMENT', 'attestation_requests', $id);
    json_out(['data' => ['statut' => 'APPROVED']]);
});

route('POST', '/rh/attestations/{id}/signer', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    if ($row['status'] !== 'APPROVED' || !$row['document_id']) {
        throw conflict('La demande doit être validée avant signature');
    }
    tx(function (PDO $pdo) use ($row, $me) {
        run(
            "UPDATE hr_document_versions SET signed_at = NOW(), signed_by = ?, signature_method = 'RH_INTERNE'
             WHERE document_id = ? AND version = (SELECT current_version FROM hr_documents WHERE id = ?)",
            [$me['id'], $row['document_id'], $row['document_id']],
            $pdo,
        );
        run("UPDATE attestation_requests SET status = 'READY' WHERE id = ?", [$row['id']], $pdo);
    });
    audit('SIGN_DOCUMENT', 'attestation_requests', $id);
    // Aucun lien ni pièce jointe : le collaborateur doit se présenter au service RH.
    notify_users([$row['employee_id']], [
        'type' => 'ATTESTATION_PRETE',
        'titre' => "Attestation {$row['numero']} prête",
        'message' => 'Votre attestation est prête. Merci de vous présenter au service RH pour récupération.',
        'lien' => '/employe/attestations/',
    ]);
    json_out(['data' => ['statut' => 'READY']]);
});

route('POST', '/rh/attestations/{id}/refuser', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    if (in_array($row['status'], ATTESTATION_STATUTS_TERMINAUX, true)) {
        throw conflict('Cette demande est déjà clôturée');
    }
    $motif = validator()->text('motif', 3, 500, 'Le motif de refus')->done()['motif'];
    run("UPDATE attestation_requests SET status = 'REJECTED', rejection_reason = ?, processed_by = ?, processed_at = NOW() WHERE id = ?", [$motif, $me['id'], $id]);
    audit('REJECT_DOCUMENT', 'attestation_requests', $id, ['motif' => $motif]);
    notify_users([$row['employee_id']], [
        'type' => 'ATTESTATION_REFUSEE',
        'titre' => "Demande d'attestation {$row['numero']} refusée",
        'message' => $motif,
        'lien' => '/employe/attestations/',
    ]);
    json_out(['data' => ['statut' => 'REJECTED']]);
});

route('POST', '/rh/attestations/{id}/annuler', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    if ($row['status'] === 'READY' || in_array($row['status'], ATTESTATION_STATUTS_TERMINAUX, true)) {
        throw conflict('Cette demande ne peut plus être annulée');
    }
    $motif = validator()->text('motif', 3, 500, "Le motif d'annulation")->done()['motif'];
    run("UPDATE attestation_requests SET status = 'CANCELLED', rejection_reason = ?, processed_by = ?, processed_at = NOW() WHERE id = ?", [$motif, $me['id'], $id]);
    audit('CANCEL_DOCUMENT', 'attestation_requests', $id, ['motif' => $motif]);
    json_out(['data' => ['statut' => 'CANCELLED']]);
});

route('POST', '/rh/attestations/{id}/reediter', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);
    require_attestation_scope($me, $row);
    if ($row['status'] !== 'READY' || !$row['document_id']) {
        throw conflict('Seule une attestation prête peut être rééditée');
    }
    $company = q1('SELECT company_name, legal_name, address, city FROM companies WHERE id = ?', [$row['company_id']]);
    $pdfBytes = generate_attestation_pdf($company, $row);
    $file = store_hr_document_bytes($pdfBytes);

    $newVersion = tx(function (PDO $pdo) use ($row, $file, $me) {
        $doc = q1('SELECT current_version FROM hr_documents WHERE id = ?', [$row['document_id']], $pdo);
        $newVersion = (int) $doc['current_version'] + 1;
        run(
            'INSERT INTO hr_document_versions (document_id, version, storage_key, file_name, file_size, checksum, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)',
            [$row['document_id'], $newVersion, $file['storage_key'], $row['numero'] . "-V$newVersion.pdf", $file['file_size'], $file['checksum'], $me['id']],
            $pdo,
        );
        run('UPDATE hr_documents SET current_version = ? WHERE id = ?', [$newVersion, $row['document_id']], $pdo);
        run('UPDATE attestation_requests SET version = ? WHERE id = ?', [$newVersion, $row['id']], $pdo);
        return $newVersion;
    });

    audit('REISSUE_DOCUMENT', 'attestation_requests', $id, ['version' => $newVersion]);
    json_out(['data' => ['statut' => 'READY', 'version' => $newVersion]]);
});

route('GET', '/rh/attestations/{id}/telecharger', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $row = load_attestation($id);

    // Vérifie la portée société AVANT toute autre chose ; journalise systématiquement,
    // y compris un refus (protection IDOR, cahier des charges §14/§42).
    $scopeOk = !($me['role'] === ROLE_RH && (int) $row['company_id'] !== (int) $me['company_id']);
    $doc = $row['document_id'] ? q1('SELECT * FROM hr_documents WHERE id = ?', [(int) $row['document_id']]) : null;
    $allowed = $scopeOk && $doc && can_download_hr_document($me, $doc);

    if (!$allowed) {
        audit_document_access('ATTESTATION_DOWNLOAD', (int) $row['document_id'], false);
        throw $doc ? forbidden() : not_found('Document introuvable');
    }
    $version = q1('SELECT * FROM hr_document_versions WHERE document_id = ? AND version = ?', [$doc['id'], $doc['current_version']]);
    $path = __DIR__ . '/../uploads/' . basename($version['storage_key']);
    if (!is_file($path)) {
        throw not_found('Fichier introuvable sur le serveur');
    }
    audit_document_access('ATTESTATION_DOWNLOAD', $doc['id'], true);

    $name = $version['file_name'];
    header('Content-Type: application/pdf');
    header('Content-Length: ' . filesize($path));
    header("Content-Disposition: attachment; filename=\"" . preg_replace('/[^A-Za-z0-9._-]/', '_', $name) . "\"; filename*=UTF-8''" . rawurlencode($name));
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    readfile($path);
    exit;
});
