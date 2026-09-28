<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
mb_internal_encoding('UTF-8');

// ---------------------------------------------------------------- Configuration
$defaults = [
    'db_host' => 'localhost', 'db_port' => 3306, 'db_name' => '', 'db_user' => '', 'db_password' => '',
    'db_direction_user' => '', 'db_direction_password' => '',
    'jwt_secret' => '', 'jwt_ttl' => 28800, 'timezone' => '+01:00',
    'site_url' => '', 'upload_max_mb' => 5, 'mail_enabled' => false, 'mail_from' => 'WORKVOICE <noreply@localhost>',
    'debug' => false,
];
define('CFG', array_merge($defaults, (array) require __DIR__ . '/../config.php'));
date_default_timezone_set('Africa/Tunis');

require __DIR__ . '/http.php';
require __DIR__ . '/db.php';
require __DIR__ . '/validate.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/services.php';
require __DIR__ . '/schema.php';
require __DIR__ . '/pdf.php';

// En-têtes de sécurité
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

// ---------------------------------------------------------------- Gestion des erreurs
set_exception_handler(function (Throwable $e) {
    if ($e instanceof HttpError) {
        $error = ['code' => $e->errorCode, 'message' => $e->getMessage()];
        if ($e->details !== null) {
            $error['details'] = $e->details;
        }
        json_out(['error' => $error], $e->status);
    }
    error_log('[workvoice] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    // Connexion MySQL impossible : message explicite pour l'installation
    if ($e instanceof PDOException && preg_match('/\[(1044|1045|1049|2002|2005)\]/', $e->getMessage())) {
        json_out(['error' => [
            'code' => 'DATABASE_UNAVAILABLE',
            'message' => 'Base de données inaccessible : vérifiez les paramètres de api/config.php.',
        ] + (CFG['debug'] ? ['debug' => $e->getMessage()] : [])], 503);
    }
    json_out(['error' => [
        'code' => 'INTERNAL_ERROR',
        'message' => 'Une erreur interne est survenue',
    ] + (CFG['debug'] ? ['debug' => $e->getMessage()] : [])], 500);
});

if (strlen((string) CFG['jwt_secret']) < 32) {
    throw new HttpError(500, 'Configuration incomplète : jwt_secret (32 caractères minimum) dans api/config.php', 'CONFIG');
}

// ---------------------------------------------------------------- Routeur
$GLOBALS['WV_ROUTES'] = [];

/** Déclare une route. {id} = entier, {kind} = mot en minuscules. */
function route(string $method, string $pattern, callable $handler): void
{
    $regex = strtr(preg_quote($pattern, '#'), [
        '\{id\}' => '(?P<id>\d+)',
        '\{kind\}' => '(?P<kind>[a-z-]+)',
    ]);
    $GLOBALS['WV_ROUTES'][] = [$method, "#^$regex$#", $handler];
}

route('GET', '/health', function () {
    $uploads = is_writable(__DIR__ . '/../uploads');
    try {
        db()->query('SELECT 1');
        $version = (string) db()->query('SELECT VERSION()')->fetchColumn();
        $present = array_column(q('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()'), 't');
        $attendus = ['users', 'companies', 'sequences', 'demandes', 'reclamations', 'suggestions', 'commentaires', 'notifications', 'audit_logs',
            'questionnaire_campagnes', 'questionnaire_questions', 'questionnaire_participations', 'questionnaire_reponses',
            'questionnaire_reponses_detail', 'v_direction_reclamations', 'v_direction_demandes',
            'jours_feries', 'conges_types', 'conges_demandes', 'conges_mouvements',
            'sorties_motifs', 'sorties_demandes', 'retards_motifs', 'retards_declarations',
            'hr_documents', 'hr_document_versions', 'attestation_requests'];
        $manquants = array_values(array_diff($attendus, $present));
        json_out(['status' => $manquants ? 'incomplete' : 'ok', 'database' => 'up', 'mysql' => $version,
            'objets' => count($attendus) - count($manquants) . '/' . count($attendus), 'manquants' => $manquants,
            'php' => PHP_VERSION, 'uploads_writable' => $uploads]);
    } catch (Throwable $e) {
        json_out(['status' => 'degraded', 'database' => 'down', 'php' => PHP_VERSION, 'uploads_writable' => $uploads]
            + (CFG['debug'] ? ['debug' => $e->getMessage()] : []), 503);
    }
});

// tickets.php en premier : il définit TICKET_KINDS, utilisé par rh.php au chargement.
// Ses routes génériques /{kind}/{id} exigent un id numérique : aucun conflit avec les autres.
require __DIR__ . '/../routes/tickets.php';
require __DIR__ . '/../routes/auth.php';
require __DIR__ . '/../routes/me.php';
require __DIR__ . '/../routes/notifications.php';
require __DIR__ . '/../routes/rh.php';
require __DIR__ . '/../routes/direction.php';
require __DIR__ . '/../routes/questionnaire.php';
require __DIR__ . '/../routes/collaborateurs.php';
require __DIR__ . '/../routes/admin.php';
require __DIR__ . '/../routes/conges.php';
require __DIR__ . '/../routes/sorties.php';
require __DIR__ . '/../routes/retards.php';
require __DIR__ . '/../routes/attestations.php';

// Chemin demandé, relatif au dossier de l'API (ex. /api/auth/me → /auth/me)
$uriPath = (string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$base = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '')), '/');
if ($base !== '' && str_starts_with($uriPath, $base)) {
    $uriPath = substr($uriPath, strlen($base));
}
$path = '/' . trim($uriPath, '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$GLOBALS['WV_PATH'] = $path;

ensure_schema();

// Toute requête modifiante doit porter un jeton CSRF valide
csrf_check();

$methodAllowed = false;
foreach ($GLOBALS['WV_ROUTES'] as [$m, $regex, $handler]) {
    if (!preg_match($regex, $path, $matches)) {
        continue;
    }
    $methodAllowed = true;
    if ($m === $method) {
        $handler(array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY));
        exit;
    }
}
if ($methodAllowed) {
    throw new HttpError(405, 'Méthode non autorisée', 'METHOD_NOT_ALLOWED');
}
throw new HttpError(404, "Route introuvable : $method $path", 'NOT_FOUND');
