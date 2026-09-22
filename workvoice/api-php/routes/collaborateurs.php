<?php
declare(strict_types=1);

/*
 * Gestion des collaborateurs par le service RH : création des comptes,
 * attribution des accès (rôle), désactivation, réinitialisation du mot de passe,
 * import en masse. Toutes les actions sont journalisées.
 */
const ROLES_ALL = [ROLE_EMPLOYE, ROLE_RH, ROLE_DIRECTION];
const USER_ADMIN_COLS = 'id, matricule, nom, prenom, email, telephone, service, departement, site, role, actif,
  mdp_temporaire, derniere_connexion, created_at';
// Coût bcrypt réduit pour les mots de passe provisoires : ils sont changés à la première connexion
const BCRYPT_COST_TEMP = 10;
const IMPORT_MAX_LIGNES = 100;

function shape_user(array $u): array
{
    $u['actif'] = (bool) $u['actif'];
    $u['mdp_temporaire'] = (bool) $u['mdp_temporaire'];
    return $u;
}

/** Mot de passe provisoire lisible (sans 0/O, 1/l/I) respectant la politique : maj., min., chiffre. */
function temp_password(): string
{
    $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    $lower = 'abcdefghijkmnpqrstuvwxyz';
    $digits = '23456789';
    $all = $upper . $lower . $digits;
    $chars = [$upper[random_int(0, 23)], $lower[random_int(0, 23)], $digits[random_int(0, 7)]];
    for ($i = 0; $i < 9; $i++) {
        $chars[] = $all[random_int(0, strlen($all) - 1)];
    }
    for ($i = count($chars) - 1; $i > 0; $i--) {
        $j = random_int(0, $i);
        [$chars[$i], $chars[$j]] = [$chars[$j], $chars[$i]];
    }
    return implode('', $chars);
}

/** Valide et normalise une fiche collaborateur. */
function validate_collaborateur(array $in): array
{
    $email = trim((string) ($in['email'] ?? ''));
    $tel = trim((string) ($in['telephone'] ?? ''));
    $matricule = mb_strtoupper(trim((string) ($in['matricule'] ?? '')));
    $v = validator(['matricule' => $matricule] + $in)
        ->text('matricule', 2, 20, 'Le matricule')
        ->check($matricule === '' || (bool) preg_match('/^[A-Z0-9._-]+$/', $matricule), 'matricule', 'Le matricule ne doit contenir que des lettres, chiffres, points ou tirets')
        ->text('nom', 1, 80, 'Le nom')
        ->text('prenom', 1, 80, 'Le prénom')
        ->text('service', 1, 80, 'Le service')
        ->text('departement', 1, 80, 'Le département')
        ->text('site', 1, 80, 'Le site')
        ->enum('role', ROLES_ALL, 'Rôle invalide', ROLE_EMPLOYE)
        ->check($email === '' || (filter_var($email, FILTER_VALIDATE_EMAIL) !== false && mb_strlen($email) <= 150), 'email', 'Adresse e-mail invalide')
        ->check(mb_strlen($tel) <= 30 && (bool) preg_match('/^[+0-9 ().-]*$/', $tel), 'telephone', 'Numéro de téléphone invalide');
    $data = $v->done();
    $data['matricule'] = $matricule;
    $data['email'] = $email === '' ? null : mb_strtolower($email);
    $data['telephone'] = $tel === '' ? null : $tel;
    return $data;
}

function load_user(int $id): array
{
    return q1('SELECT ' . USER_ADMIN_COLS . ' FROM users WHERE id = ?', [$id]) ?? throw not_found('Collaborateur introuvable');
}

/** Empêche de laisser l'application sans aucun RH actif. */
function assert_other_active_rh(int $userId): void
{
    $others = (int) q1("SELECT COUNT(*) AS n FROM users WHERE role = 'RH' AND actif = 1 AND id <> ?", [$userId])['n'];
    if ($others === 0) {
        throw conflict("Impossible : ce compte est le dernier accès RH actif de l'application.");
    }
}

function insert_collaborateur(array $data): array
{
    $password = temp_password();
    try {
        run(
            'INSERT INTO users (matricule, nom, prenom, email, telephone, service, departement, site, role, password, mdp_temporaire, actif)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)',
            [
                $data['matricule'], $data['nom'], $data['prenom'], $data['email'], $data['telephone'],
                $data['service'], $data['departement'], $data['site'], $data['role'],
                password_hash($password, PASSWORD_BCRYPT, ['cost' => BCRYPT_COST_TEMP]),
            ],
        );
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict(str_contains($e->getMessage(), 'email')
                ? 'Cette adresse e-mail est déjà utilisée par un autre collaborateur'
                : "Le matricule {$data['matricule']} existe déjà");
        }
        throw $e;
    }
    return [(int) db()->lastInsertId(), $password];
}

// ---------------------------------------------------------------- Liste

route('GET', '/rh/collaborateurs', function () {
    require_role(ROLE_RH);
    $where = [];
    $params = [];
    if ($search = qp('q')) {
        $where[] = "(matricule LIKE ? OR nom LIKE ? OR prenom LIKE ? OR email LIKE ? OR CONCAT(prenom, ' ', nom) LIKE ?)";
        array_push($params, ...array_fill(0, 5, like($search)));
    }
    $role = qp('role');
    if ($role && in_array($role, ROLES_ALL, true)) { $where[] = 'role = ?'; $params[] = $role; }
    $actif = qp('actif');
    if ($actif === 'true') { $where[] = 'actif = 1'; }
    if ($actif === 'false') { $where[] = 'actif = 0'; }
    foreach (['site', 'departement', 'service'] as $col) {
        if ($v = qp($col, 80)) { $where[] = "$col = ?"; $params[] = $v; }
    }
    $whereSql = $where ? 'WHERE ' . implode(' AND ', $where) : '';
    $pg = pagination(25);

    $rows = q('SELECT ' . USER_ADMIN_COLS . " FROM users $whereSql ORDER BY nom, prenom LIMIT {$pg['limit']} OFFSET {$pg['offset']}", $params);
    $total = (int) q1("SELECT COUNT(*) AS n FROM users $whereSql", $params)['n'];
    $stats = q1(
        "SELECT CAST(COALESCE(SUM(actif = 1), 0) AS SIGNED) AS actifs,
                CAST(COALESCE(SUM(actif = 0), 0) AS SIGNED) AS inactifs,
                CAST(COALESCE(SUM(actif = 1 AND role = 'EMPLOYE'), 0) AS SIGNED) AS employes,
                CAST(COALESCE(SUM(actif = 1 AND role = 'RH'), 0) AS SIGNED) AS rh,
                CAST(COALESCE(SUM(actif = 1 AND role = 'DIRECTION'), 0) AS SIGNED) AS direction,
                CAST(COALESCE(SUM(actif = 1 AND mdp_temporaire = 1), 0) AS SIGNED) AS en_attente_activation
         FROM users",
    );
    json_out(paged(array_map('shape_user', $rows), $total, $pg) + ['stats' => $stats]);
});

// ---------------------------------------------------------------- Création

route('POST', '/rh/collaborateurs', function () {
    require_role(ROLE_RH);
    $data = validate_collaborateur(body());
    [$id, $password] = insert_collaborateur($data);
    audit('COLLABORATEUR_CREATION', 'users', $id, ['matricule' => $data['matricule'], 'role' => $data['role']]);
    // Le mot de passe provisoire n'est renvoyé qu'une seule fois, ici
    json_out(['data' => shape_user(load_user($id)), 'mot_de_passe_temporaire' => $password], 201);
});

// ---------------------------------------------------------------- Modification (dont le rôle = les accès)

route('PUT', '/rh/collaborateurs/{id}', function (array $p) {
    $me = require_role(ROLE_RH);
    $id = (int) $p['id'];
    $before = load_user($id);
    $data = validate_collaborateur(body());

    if ($before['role'] === ROLE_RH && $data['role'] !== ROLE_RH) {
        if ($id === (int) $me['id']) {
            throw conflict('Vous ne pouvez pas retirer votre propre accès RH.');
        }
        assert_other_active_rh($id);
    }
    try {
        run(
            'UPDATE users SET matricule = ?, nom = ?, prenom = ?, email = ?, telephone = ?, service = ?, departement = ?, site = ?, role = ?
             WHERE id = ?',
            [$data['matricule'], $data['nom'], $data['prenom'], $data['email'], $data['telephone'],
             $data['service'], $data['departement'], $data['site'], $data['role'], $id],
        );
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict(str_contains($e->getMessage(), 'email') ? 'Cette adresse e-mail est déjà utilisée' : 'Ce matricule existe déjà');
        }
        throw $e;
    }
    $changes = [];
    foreach (['matricule', 'nom', 'prenom', 'email', 'telephone', 'service', 'departement', 'site', 'role'] as $k) {
        if ((string) $before[$k] !== (string) $data[$k]) {
            $changes[$k] = ['de' => $before[$k], 'vers' => $data[$k]];
        }
    }
    audit(isset($changes['role']) ? 'COLLABORATEUR_ACCES_MODIFIE' : 'COLLABORATEUR_MODIFICATION', 'users', $id, $changes ?: null);
    json_out(['data' => shape_user(load_user($id))]);
});

// ---------------------------------------------------------------- Activer / désactiver l'accès

route('PATCH', '/rh/collaborateurs/{id}/statut', function (array $p) {
    $me = require_role(ROLE_RH);
    $id = (int) $p['id'];
    $user = load_user($id);
    $actif = validator()->bool('actif')->done()['actif'];

    if (!$actif) {
        if ($id === (int) $me['id']) {
            throw conflict('Vous ne pouvez pas désactiver votre propre compte.');
        }
        if ($user['role'] === ROLE_RH) {
            assert_other_active_rh($id);
        }
    }
    run('UPDATE users SET actif = ? WHERE id = ?', [$actif ? 1 : 0, $id]);
    // Effet immédiat : chaque requête revérifie en base que le compte est actif
    audit($actif ? 'COLLABORATEUR_REACTIVATION' : 'COLLABORATEUR_DESACTIVATION', 'users', $id, ['matricule' => $user['matricule']]);
    json_out(['data' => shape_user(load_user($id))]);
});

// ---------------------------------------------------------------- Réinitialiser le mot de passe

route('POST', '/rh/collaborateurs/{id}/mot-de-passe', function (array $p) {
    require_role(ROLE_RH);
    $id = (int) $p['id'];
    $user = load_user($id);
    $password = temp_password();
    run('UPDATE users SET password = ?, mdp_temporaire = 1 WHERE id = ?', [password_hash($password, PASSWORD_BCRYPT, ['cost' => BCRYPT_COST_TEMP]), $id]);
    audit('COLLABORATEUR_MDP_REINITIALISE', 'users', $id, ['matricule' => $user['matricule']]);
    json_out(['data' => shape_user(load_user($id)), 'mot_de_passe_temporaire' => $password]);
});

// ---------------------------------------------------------------- Import en masse

route('POST', '/rh/collaborateurs/import', function () {
    require_role(ROLE_RH);
    $lignes = body()['lignes'] ?? null;
    if (!is_array($lignes) || !$lignes) {
        throw bad_request('Aucune ligne à importer');
    }
    if (count($lignes) > IMPORT_MAX_LIGNES) {
        throw bad_request('Maximum ' . IMPORT_MAX_LIGNES . ' lignes par envoi');
    }
    @set_time_limit(120);

    $resultats = [];
    $crees = 0;
    foreach (array_values($lignes) as $i => $ligne) {
        $numero = (int) ($ligne['_ligne'] ?? $i + 1);
        $base = ['ligne' => $numero, 'matricule' => (string) ($ligne['matricule'] ?? ''), 'nom' => (string) ($ligne['nom'] ?? ''), 'prenom' => (string) ($ligne['prenom'] ?? '')];
        try {
            $data = validate_collaborateur(is_array($ligne) ? $ligne : []);
            [$id, $password] = insert_collaborateur($data);
            $crees++;
            $resultats[] = $base + ['matricule' => $data['matricule'], 'statut' => 'cree', 'id' => $id, 'role' => $data['role'], 'mot_de_passe' => $password];
        } catch (HttpError $e) {
            $message = $e->getMessage();
            if (is_array($e->details)) {
                $message = implode(' · ', array_column($e->details, 'message'));
            }
            $resultats[] = $base + ['statut' => 'erreur', 'message' => $message];
        }
    }
    audit('COLLABORATEURS_IMPORT', 'users', null, ['lignes' => count($lignes), 'crees' => $crees]);
    json_out(['data' => ['crees' => $crees, 'erreurs' => count($lignes) - $crees, 'resultats' => $resultats]]);
});
