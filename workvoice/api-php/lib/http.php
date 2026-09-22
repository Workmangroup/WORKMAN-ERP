<?php
declare(strict_types=1);

/** Erreur HTTP renvoyée au client au format { error: { code, message, details } }. */
final class HttpError extends Exception
{
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly string $errorCode = 'ERROR',
        public readonly mixed $details = null,
    ) {
        parent::__construct($message);
    }
}

function bad_request(string $m, mixed $d = null): HttpError { return new HttpError(400, $m, 'BAD_REQUEST', $d); }
function unauthorized(string $m = 'Authentification requise'): HttpError { return new HttpError(401, $m, 'UNAUTHORIZED'); }
function forbidden(string $m = 'Accès refusé'): HttpError { return new HttpError(403, $m, 'FORBIDDEN'); }
function not_found(string $m = 'Ressource introuvable'): HttpError { return new HttpError(404, $m, 'NOT_FOUND'); }
function conflict(string $m): HttpError { return new HttpError(409, $m, 'CONFLICT'); }

/**
 * Convertit récursivement les dates MySQL « 2026-09-22 10:30:00 » au format ISO
 * « 2026-09-22T10:30:00 », lu de façon fiable par tous les navigateurs.
 */
function iso_dates(mixed $v): mixed
{
    if (is_array($v)) {
        foreach ($v as $k => $x) {
            $v[$k] = iso_dates($x);
        }
        return $v;
    }
    if (is_string($v) && strlen($v) === 19 && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $v)) {
        return str_replace(' ', 'T', $v);
    }
    return $v;
}

function json_out(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(iso_dates($data), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function no_content(): never
{
    http_response_code(204);
    exit;
}

/** Corps de la requête : JSON (application/json) ou formulaire (multipart). */
function body(): array
{
    static $body = null;
    if ($body !== null) {
        return $body;
    }
    $type = $_SERVER['CONTENT_TYPE'] ?? '';
    if (str_contains($type, 'application/json')) {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw === '') {
            return $body = [];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new HttpError(400, 'Corps de requête JSON invalide', 'BAD_JSON');
        }
        return $body = $data;
    }
    return $body = $_POST;
}

/** Paramètre d'URL (?cle=valeur) nettoyé ; null s'il est absent ou vide. */
function qp(string $key, int $max = 100): ?string
{
    $v = $_GET[$key] ?? null;
    if (!is_string($v)) {
        return null;
    }
    $v = trim($v);
    return $v === '' ? null : mb_substr($v, 0, $max);
}

function client_ip(): string
{
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || ((int) ($_SERVER['SERVER_PORT'] ?? 0) === 443);
}

/** Pagination : page (≥1) et pageSize (1–100). */
function pagination(int $defaultSize = 20): array
{
    $page = max(1, (int) ($_GET['page'] ?? 1));
    $size = min(100, max(1, (int) ($_GET['pageSize'] ?? $defaultSize)));
    return ['page' => $page, 'pageSize' => $size, 'limit' => $size, 'offset' => ($page - 1) * $size];
}

function paged(array $data, int $total, array $p): array
{
    return [
        'data' => $data,
        'total' => $total,
        'page' => $p['page'],
        'pageSize' => $p['pageSize'],
        'pages' => max(1, (int) ceil($total / $p['pageSize'])),
    ];
}

/** Échappe les jokers LIKE (%, _) d'une recherche utilisateur. */
function like(string $s): string
{
    return '%' . addcslashes($s, '\\%_') . '%';
}
