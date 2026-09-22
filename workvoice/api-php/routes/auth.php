<?php
declare(strict_types=1);

const PUBLIC_USER_COLS = 'id, matricule, nom, prenom, email, telephone, service, departement, site, role, derniere_connexion, mdp_temporaire';

function public_user(int $id): array
{
    $u = q1('SELECT ' . PUBLIC_USER_COLS . ' FROM users WHERE id = ?', [$id]);
    $u['mdp_temporaire'] = (bool) $u['mdp_temporaire'];
    return $u;
}

route('GET', '/auth/csrf', function () {
    json_out(['csrfToken' => issue_csrf()]);
});

route('POST', '/auth/login', function () {
    // Anti force brute : 10 échecs par IP sur 15 minutes
    $echecs = (int) q1(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'CONNEXION_ECHEC' AND ip = ? AND date_creation > NOW() - INTERVAL 15 MINUTE",
        [client_ip()],
    )['n'];
    if ($echecs >= 10) {
        throw new HttpError(429, 'Trop de tentatives. Réessayez dans 15 minutes.', 'TOO_MANY_ATTEMPTS');
    }

    $v = validator()->text('matricule', 1, 20, 'Le matricule')->text('password', 1, 200, 'Le mot de passe')->done();
    $matricule = mb_strtoupper($v['matricule']);
    $user = q1('SELECT id, role, password, actif FROM users WHERE matricule = ?', [$matricule]);

    $ok = verify_password((string) body()['password'], $user['password'] ?? DUMMY_HASH);
    if (!$user || !$ok || !(int) $user['actif']) {
        audit('CONNEXION_ECHEC', null, null, ['matricule' => $matricule], $user['id'] ?? null);
        throw unauthorized('Matricule ou mot de passe incorrect');
    }

    set_app_cookie(AUTH_COOKIE, jwt_sign($user), true, (int) CFG['jwt_ttl']);
    issue_csrf(); // nouveau jeton CSRF à chaque connexion
    run('UPDATE users SET derniere_connexion = NOW() WHERE id = ?', [$user['id']]);
    audit('CONNEXION', null, null, null, (int) $user['id']);

    json_out(['data' => public_user((int) $user['id'])]);
});

route('POST', '/auth/logout', function () {
    set_app_cookie(AUTH_COOKIE, '', true);
    no_content();
});

route('GET', '/auth/me', function () {
    json_out(['data' => public_user((int) current_user()['id'])]);
});

route('PUT', '/auth/password', function () {
    $user = current_user();
    $in = body();
    $nouveau = (string) ($in['nouveau'] ?? '');
    validator()
        ->text('ancien', 1, 200, "L'ancien mot de passe")
        ->check(mb_strlen($nouveau) >= 10, 'nouveau', 'Au moins 10 caractères')
        ->check((bool) preg_match('/[a-z]/', $nouveau), 'nouveau', 'Au moins une minuscule')
        ->check((bool) preg_match('/[A-Z]/', $nouveau), 'nouveau', 'Au moins une majuscule')
        ->check((bool) preg_match('/[0-9]/', $nouveau), 'nouveau', 'Au moins un chiffre')
        ->check(($in['ancien'] ?? null) !== $nouveau, 'nouveau', "Le nouveau mot de passe doit être différent de l'ancien")
        ->done();

    $hash = q1('SELECT password FROM users WHERE id = ?', [$user['id']])['password'];
    if (!verify_password((string) $in['ancien'], $hash)) {
        throw new HttpError(400, 'Ancien mot de passe incorrect', 'BAD_PASSWORD');
    }
    run('UPDATE users SET password = ?, mdp_temporaire = 0 WHERE id = ?', [password_hash($nouveau, PASSWORD_BCRYPT, ['cost' => BCRYPT_COST]), $user['id']]);
    audit('MOT_DE_PASSE_CHANGEMENT');
    no_content();
});
