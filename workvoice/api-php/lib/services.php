<?php
declare(strict_types=1);

// ---------------------------------------------------------------- Référentiels

const ROLE_EMPLOYE = 'EMPLOYE';
const ROLE_RH = 'RH';
const ROLE_DIRECTION = 'DIRECTION';
// Multi-société (V2) : rôle technique global, ne réalise pas d'opérations RH quotidiennes.
const ROLE_SYSTEM_ADMIN = 'SYSTEM_ADMIN';

const STATUTS = ['NOUVEAU', 'EN_COURS', 'EN_ATTENTE', 'RESOLU', 'CLOTURE'];
const STATUTS_TERMINES = ['RESOLU', 'CLOTURE'];
const NIVEAUX_URGENCE = ['FAIBLE', 'MOYEN', 'ELEVE', 'CRITIQUE'];

// Modules Congés / Sorties / Retards — workflow Collaborateur → RH → Validation/Refus.
// Congés a en plus l'état BROUILLON ; Sorties et Retards utilisent le même sous-ensemble.
const CONGE_STATUTS = ['BROUILLON', 'EN_ATTENTE', 'VALIDE', 'REFUSE', 'ANNULE'];
const ABSENCE_STATUTS = ['EN_ATTENTE', 'VALIDE', 'REFUSE', 'ANNULE'];
const TYPES_CONTRAT = ['CDI', 'CDD', 'SIVP', 'STAGE', 'INTERIM', 'AUTRE'];

// Module Attestations RH — workflow dédié, distinct des demandes RH génériques
// (voir AUDIT_ATTESTATIONS_COFFRE_FORT_CEO.md §2 : la réutilisation de « demandes »
// est incompatible avec l'exigence « le collaborateur ne télécharge jamais le PDF »).
const ATTESTATION_TYPES = ['ATTESTATION_TRAVAIL', 'ATTESTATION_SALAIRE'];
const ATTESTATION_STATUTS = ['SUBMITTED', 'IN_REVIEW', 'GENERATED', 'APPROVED', 'READY', 'REJECTED', 'CANCELLED'];
const ATTESTATION_STATUTS_TERMINAUX = ['READY', 'REJECTED', 'CANCELLED'];

const LABELS = [
    'statut' => ['NOUVEAU' => 'Nouveau', 'EN_COURS' => 'En cours', 'EN_ATTENTE' => 'En attente', 'RESOLU' => 'Résolu', 'CLOTURE' => 'Clôturé'],
    'type_demande' => [
        'ATTESTATION_TRAVAIL' => 'Attestation de travail', 'ATTESTATION_SALAIRE' => 'Attestation de salaire',
        'SOLDE_CONGES' => 'Solde congés', 'CONGE' => 'Congé', 'AVANCE_SALAIRE' => 'Avance sur salaire',
        'FORMATION' => 'Formation', 'AUTRE' => 'Autre',
    ],
    'categorie' => [
        'PAIE' => 'Paie', 'CONDITIONS_TRAVAIL' => 'Conditions de travail', 'RESPONSABLE_HIERARCHIQUE' => 'Responsable hiérarchique',
        'EQUIPEMENT' => 'Équipement', 'SECURITE' => 'Sécurité', 'HARCELEMENT' => 'Harcèlement',
        'ORGANISATION' => 'Organisation', 'AUTRE' => 'Autre',
    ],
    'theme' => [
        'ORGANISATION' => 'Organisation', 'QUALITE' => 'Qualité', 'SECURITE' => 'Sécurité', 'BIEN_ETRE' => 'Bien-être',
        'ENVIRONNEMENT' => 'Environnement', 'DIGITAL' => 'Digital', 'AUTRE' => 'Autre',
    ],
    'statut_absence' => [
        'BROUILLON' => 'Brouillon', 'EN_ATTENTE' => 'En attente', 'VALIDE' => 'Validé', 'REFUSE' => 'Refusé', 'ANNULE' => 'Annulé',
    ],
    'type_contrat' => [
        'CDI' => 'CDI', 'CDD' => 'CDD', 'SIVP' => 'SIVP', 'STAGE' => 'Stage', 'INTERIM' => 'Intérim', 'AUTRE' => 'Autre',
    ],
    'attestation_statut' => [
        'SUBMITTED' => 'Soumise', 'IN_REVIEW' => 'En cours de traitement', 'GENERATED' => 'Document généré',
        'APPROVED' => 'Validée', 'READY' => 'Prête', 'REJECTED' => 'Refusée', 'CANCELLED' => 'Annulée',
    ],
];

/** Pièces jointes autorisées : extension → types MIME acceptés. */
const ALLOWED_UPLOADS = [
    'pdf' => ['application/pdf'],
    'jpg' => ['image/jpeg'],
    'jpeg' => ['image/jpeg'],
    'png' => ['image/png'],
    'doc' => ['application/msword', 'application/CDFV2', 'application/x-ole-storage'],
    'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
    // Accepté en plus pour les déclarations de retard (justificatifs multiples)
    'zip' => ['application/zip', 'application/x-zip-compressed', 'application/x-zip'],
];

// ---------------------------------------------------------------- Pièces jointes (générique)

/**
 * Enregistre la pièce jointe d'un champ de formulaire, restreinte à une liste
 * d'extensions (sous-ensemble de ALLOWED_UPLOADS). Utilisée par les modules
 * Congés et Retards ; les demandes RH gardent leur propre store_upload().
 */
function store_upload_field(string $field, array $allowedExt): ?array
{
    $f = $_FILES[$field] ?? null;
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
    $allowedMimes = array_intersect_key(ALLOWED_UPLOADS, array_flip($allowedExt));
    if (!isset($allowedMimes[$ext]) || !in_array($mime, $allowedMimes[$ext], true)) {
        throw new HttpError(400, 'Type de fichier non autorisé (' . strtoupper(implode(', ', $allowedExt)) . ' uniquement)', 'UPLOAD_ERROR');
    }
    $stored = bin2hex(random_bytes(16)) . '.' . $ext;
    if (!move_uploaded_file($f['tmp_name'], __DIR__ . "/../uploads/$stored")) {
        throw new RuntimeException("Impossible d'enregistrer la pièce jointe (droits du dossier uploads ?)");
    }
    return [
        'piece_jointe' => $stored,
        'piece_jointe_nom' => mb_substr(basename((string) $f['name']), 0, 255),
        'piece_jointe_mime' => $mime,
    ];
}

/** Télécharge une pièce jointe générique déjà validée comme appartenant au viewer. */
function download_stored_file(?string $stored, ?string $nom, ?string $mime): void
{
    if (!$stored) {
        throw not_found('Aucune pièce jointe');
    }
    $path = __DIR__ . '/../uploads/' . basename($stored);
    if (!is_file($path)) {
        throw not_found('Fichier introuvable sur le serveur');
    }
    $name = $nom ?: 'piece-jointe';
    header('Content-Type: ' . ($mime ?: 'application/octet-stream'));
    header('Content-Length: ' . filesize($path));
    header("Content-Disposition: attachment; filename=\"" . preg_replace('/[^A-Za-z0-9._-]/', '_', $name) . "\"; filename*=UTF-8''" . rawurlencode($name));
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
}

// ---------------------------------------------------------------- Coffre-Fort RH (documents sensibles)

/**
 * Règle de sécurité absolue du module Attestations/Coffre-Fort : le
 * collaborateur propriétaire du document n'a JAMAIS accès en téléchargement,
 * quelle que soit la situation (voir cahier des charges §12). Seuls RH (de
 * la même société) et SYSTEM_ADMIN peuvent télécharger un document sensible.
 */
function can_download_hr_document(array $user, array $doc): bool
{
    if (!in_array($user['role'], [ROLE_RH, ROLE_SYSTEM_ADMIN], true)) {
        return false;
    }
    if ($user['role'] === ROLE_RH && (int) $user['company_id'] !== (int) $doc['company_id']) {
        return false;
    }
    return true;
}

/** Enregistre un document déjà généré (bytes en mémoire, jamais un upload utilisateur direct). */
function store_hr_document_bytes(string $bytes, string $ext = 'pdf'): array
{
    $stored = bin2hex(random_bytes(16)) . '.' . $ext;
    if (file_put_contents(__DIR__ . "/../uploads/$stored", $bytes) === false) {
        throw new RuntimeException("Impossible d'enregistrer le document (droits du dossier uploads ?)");
    }
    return [
        'storage_key' => $stored,
        'file_size' => strlen($bytes),
        'checksum' => hash('sha256', $bytes),
    ];
}

/** Journalise un accès (ou une tentative refusée) à un document RH sensible. */
function audit_document_access(string $action, int $documentId, bool $granted, ?int $userId = null): void
{
    audit($granted ? $action : 'ACCESS_DENIED', 'hr_documents', $documentId, $granted ? null : ['action_demandee' => $action], $userId);
}

// ---------------------------------------------------------------- Journal d'audit

/** Journalise une action ; ne fait jamais échouer l'action métier. */
function audit(string $action, ?string $entite = null, ?int $entiteId = null, ?array $details = null, ?int $userId = null): void
{
    try {
        run(
            'INSERT INTO audit_logs (user_id, action, entite, entite_id, ip, user_agent, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                $userId ?? ($GLOBALS['WV_USER']['id'] ?? null),
                $action,
                $entite,
                $entiteId,
                client_ip(),
                substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255) ?: null,
                $details ? json_encode($details, JSON_UNESCAPED_UNICODE) : null,
            ],
        );
    } catch (Throwable $e) {
        error_log('[workvoice][audit] ' . $e->getMessage());
    }
}

// ---------------------------------------------------------------- Notifications

function send_mail(string $to, string $titre, string $message, ?string $lien): void
{
    if (!CFG['mail_enabled']) {
        return;
    }
    $url = rtrim(CFG['site_url'], '/') . ($lien ?? '/');
    $e = fn (string $s) => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
    $html = '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">'
        . '<div style="background:#0b3d91;color:#fff;padding:16px 24px;font-weight:600;font-size:18px">WORKVOICE <span style="color:#ffc20e">·</span> Portail Collaborateur Workman</div>'
        . '<div style="padding:24px;color:#111827"><h2 style="margin:0 0 12px;font-size:18px">' . $e($titre) . '</h2>'
        . '<p style="margin:0 0 24px;line-height:1.5">' . $e($message) . '</p>'
        . '<a href="' . $e($url) . '" style="background:#ffc20e;color:#0b3d91;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Ouvrir WORKVOICE</a></div>'
        . '<div style="background:#f3f4f6;padding:12px 24px;font-size:12px;color:#6b7280">Message automatique — merci de ne pas répondre.</div></div>';
    $headers = implode("\r\n", [
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'From: ' . CFG['mail_from'],
    ]);
    if (!@mail($to, mb_encode_mimeheader('[WORKVOICE] ' . $titre, 'UTF-8'), $html, $headers)) {
        error_log("[workvoice][mail] échec d'envoi à $to");
    }
}

/**
 * Notifications in-app (+ e-mail) pour une liste d'utilisateurs. À appeler après
 * l'enregistrement ; ne contient jamais l'identité de l'auteur d'un ticket.
 */
function notify_users(array $userIds, array $n, bool $email = true): void
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $userIds))));
    if (!$ids) {
        return;
    }
    try {
        $values = implode(', ', array_fill(0, count($ids), '(?, ?, ?, ?, ?)'));
        $params = [];
        foreach ($ids as $id) {
            array_push($params, $id, $n['type'], $n['titre'], $n['message'], $n['lien'] ?? null);
        }
        run("INSERT INTO notifications (user_id, type, titre, message, lien) VALUES $values", $params);

        if ($email && CFG['mail_enabled']) {
            $rows = q('SELECT email FROM users WHERE id IN (' . placeholders($ids) . ') AND actif = 1 AND email IS NOT NULL', $ids);
            foreach ($rows as $r) {
                send_mail($r['email'], $n['titre'], $n['message'], $n['lien'] ?? null);
            }
        }
    } catch (Throwable $e) {
        error_log('[workvoice][notification] ' . $e->getMessage());
    }
}

function notify_role(string $role, array $n, ?int $excludeUserId = null, bool $email = true): void
{
    try {
        $ids = array_column(q('SELECT id FROM users WHERE role = ? AND actif = 1', [$role]), 'id');
        notify_users(array_filter($ids, fn ($id) => $id !== $excludeUserId), $n, $email);
    } catch (Throwable $e) {
        error_log('[workvoice][notification] ' . $e->getMessage());
    }
}
