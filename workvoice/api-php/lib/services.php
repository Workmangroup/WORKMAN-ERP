<?php
declare(strict_types=1);

// ---------------------------------------------------------------- Référentiels

const ROLE_EMPLOYE = 'EMPLOYE';
const ROLE_RH = 'RH';
const ROLE_DIRECTION = 'DIRECTION';

const STATUTS = ['NOUVEAU', 'EN_COURS', 'EN_ATTENTE', 'RESOLU', 'CLOTURE'];
const STATUTS_TERMINES = ['RESOLU', 'CLOTURE'];
const NIVEAUX_URGENCE = ['FAIBLE', 'MOYEN', 'ELEVE', 'CRITIQUE'];

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
];

/** Pièces jointes autorisées : extension → types MIME acceptés. */
const ALLOWED_UPLOADS = [
    'pdf' => ['application/pdf'],
    'jpg' => ['image/jpeg'],
    'jpeg' => ['image/jpeg'],
    'png' => ['image/png'],
    'doc' => ['application/msword', 'application/CDFV2', 'application/x-ole-storage'],
    'docx' => ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip'],
];

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
