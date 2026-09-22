<?php
declare(strict_types=1);

const AUTH_COOKIE = 'wv_token';
const CSRF_COOKIE = 'wv_csrf';
const JWT_ISSUER = 'workvoice';
const BCRYPT_COST = 12;
// Hash « leurre » : un matricule inconnu coûte le même temps qu'un mauvais mot de passe
const DUMMY_HASH = '$2y$12$Q7fH9yEbnf56BSlm2XUn0ud/nFlKuznSZ.DsIFAeV9.lPZjbS8NaW';

function b64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function b64url_decode(string $data): string|false
{
    return base64_decode(strtr($data, '-_', '+/'), true);
}

/** JWT HS256 signé avec la clé de config.php. */
function jwt_sign(array $user): string
{
    $now = time();
    $header = b64url(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $payload = b64url(json_encode([
        'sub' => (string) $user['id'],
        'role' => $user['role'],
        'iss' => JWT_ISSUER,
        'iat' => $now,
        'exp' => $now + (int) CFG['jwt_ttl'],
    ]));
    $signature = b64url(hash_hmac('sha256', "$header.$payload", CFG['jwt_secret'], true));
    return "$header.$payload.$signature";
}

function jwt_verify(string $token): ?array
{
    $parts = explode('.', $token);
    if (count($parts) !== 3) {
        return null;
    }
    [$h, $p, $s] = $parts;
    $header = json_decode((string) b64url_decode($h), true);
    if (($header['alg'] ?? '') !== 'HS256') {
        return null; // refuse « alg: none » et tout autre algorithme
    }
    $expected = b64url(hash_hmac('sha256', "$h.$p", CFG['jwt_secret'], true));
    if (!hash_equals($expected, $s)) {
        return null;
    }
    $payload = json_decode((string) b64url_decode($p), true);
    if (!is_array($payload) || ($payload['iss'] ?? '') !== JWT_ISSUER || (int) ($payload['exp'] ?? 0) < time()) {
        return null;
    }
    return $payload;
}

function set_app_cookie(string $name, string $value, bool $httpOnly, int $maxAge = 0): void
{
    setcookie($name, $value, [
        'expires' => $maxAge > 0 ? time() + $maxAge : ($value === '' ? time() - 3600 : 0),
        'path' => '/',
        'secure' => is_https(),
        'httponly' => $httpOnly,
        'samesite' => 'Lax',
    ]);
}

/** Émet un jeton CSRF (cookie lisible par le frontend, renvoyé dans l'en-tête X-CSRF-Token). */
function issue_csrf(): string
{
    $token = bin2hex(random_bytes(32));
    set_app_cookie(CSRF_COOKIE, $token, false);
    return $token;
}

/** Protection « double-submit cookie » sur toute requête modifiante. */
function csrf_check(): void
{
    if (in_array($_SERVER['REQUEST_METHOD'], ['GET', 'HEAD', 'OPTIONS'], true)) {
        return;
    }
    $cookie = (string) ($_COOKIE[CSRF_COOKIE] ?? '');
    $header = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
    if ($cookie === '' || $header === '' || !hash_equals($cookie, $header)) {
        throw new HttpError(403, 'Jeton CSRF invalide ou manquant', 'CSRF_INVALID');
    }
}

/**
 * Utilisateur connecté. Le compte est relu en base à chaque requête :
 * un compte désactivé ou dont le rôle a changé perd l'accès immédiatement.
 */
function current_user(): array
{
    static $user = null;
    if ($user !== null) {
        return $user;
    }
    $token = (string) ($_COOKIE[AUTH_COOKIE] ?? '');
    if ($token === '') {
        throw unauthorized();
    }
    $payload = jwt_verify($token);
    if (!$payload) {
        throw unauthorized('Session expirée, veuillez vous reconnecter');
    }
    $row = q1(
        'SELECT id, matricule, nom, prenom, email, telephone, service, departement, site, role, mdp_temporaire
         FROM users WHERE id = ? AND actif = 1',
        [(int) $payload['sub']],
    );
    if (!$row || $row['role'] !== $payload['role']) {
        throw unauthorized('Session invalide');
    }
    // Mot de passe provisoire (créé ou réinitialisé par le RH) : seul le changement de mot de passe est permis
    $allowed = ['/auth/me', '/auth/password', '/auth/logout'];
    if ((int) $row['mdp_temporaire'] === 1 && !in_array($GLOBALS['WV_PATH'] ?? '', $allowed, true)) {
        throw new HttpError(403, 'Vous devez choisir votre mot de passe personnel avant de continuer', 'PASSWORD_CHANGE_REQUIRED');
    }
    $GLOBALS['WV_USER'] = $row;
    return $user = $row;
}

/** Restreint l'accès à certains rôles et renvoie l'utilisateur. */
function require_role(string ...$roles): array
{
    $user = current_user();
    if (!in_array($user['role'], $roles, true)) {
        throw forbidden();
    }
    return $user;
}

/** Vérification bcrypt compatible avec les hash générés par Node ($2b$). */
function verify_password(string $password, string $hash): bool
{
    if (str_starts_with($hash, '$2b$')) {
        $hash = '$2y$' . substr($hash, 4);
    }
    return password_verify($password, $hash);
}
