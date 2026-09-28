<?php
declare(strict_types=1);

/*
 * Gestion des collaborateurs par le service RH : création des comptes,
 * attribution des accès (rôle), désactivation, réinitialisation du mot de passe,
 * import en masse. Toutes les actions sont journalisées.
 */
const ROLES_ALL = [ROLE_EMPLOYE, ROLE_RH, ROLE_DIRECTION];
const USER_ADMIN_COLS = 'id, matricule, nom, prenom, email, telephone, service, departement, site, role, company_id, actif,
  mdp_temporaire, derniere_connexion, created_at,
  societe, fonction, manager_id, matricule_paie, date_naissance, adresse, cin, cin_date_delivrance, cnss,
  date_embauche, date_fin_contrat, type_contrat, salaire_base, prime, indemnite, observations_rh,
  solde_conge_initial, solde_conge_actuel';
// Champs de la fiche enrichie (Module 4) : tous facultatifs, remplissables à la création ou plus tard.
const FICHE_CHAMPS_TEXTE = [
    'societe' => ['max' => 80, 'label' => 'La société'],
    'fonction' => ['max' => 100, 'label' => 'La fonction'],
    'matricule_paie' => ['max' => 20, 'label' => 'Le matricule paie'],
    'adresse' => ['max' => 255, 'label' => "L'adresse"],
    'cin' => ['max' => 20, 'label' => 'Le numéro CIN'],
    'cnss' => ['max' => 30, 'label' => 'Le numéro CNSS'],
];
const FICHE_CHAMPS_DATE = [
    'date_naissance' => 'La date de naissance',
    'cin_date_delivrance' => 'La date de délivrance du CIN',
    'date_embauche' => "La date d'embauche",
    'date_fin_contrat' => 'La date de fin de contrat',
];
const FICHE_CHAMPS_MONTANT = ['salaire_base', 'prime', 'indemnite'];
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

/** Valide et normalise une fiche collaborateur (identité de base + Module 4, tout optionnel sauf le socle existant). */
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

    foreach (FICHE_CHAMPS_TEXTE as $champ => $meta) {
        $v->text($champ, 0, $meta['max'], $meta['label'], true);
    }
    foreach (FICHE_CHAMPS_DATE as $champ => $label) {
        $v->date($champ, $label, true);
    }
    $v->text('observations_rh', 0, 2000, 'Les observations', true);
    // Pas de valeur par défaut pertinente pour un type de contrat : vérifié à la main (nullable)
    $typeContrat = trim((string) ($in['type_contrat'] ?? ''));
    $v->check($typeContrat === '' || in_array($typeContrat, TYPES_CONTRAT, true), 'type_contrat', 'Type de contrat invalide');

    $data = $v->done();
    $data['matricule'] = $matricule;
    $data['email'] = $email === '' ? null : mb_strtolower($email);
    $data['telephone'] = $tel === '' ? null : $tel;
    $data['type_contrat'] = $typeContrat === '' ? null : $typeContrat;

    foreach (FICHE_CHAMPS_MONTANT as $champ) {
        $raw = $in[$champ] ?? null;
        if ($raw === null || $raw === '') {
            $data[$champ] = null;
            continue;
        }
        if (!is_numeric($raw) || (float) $raw < 0 || (float) $raw > 999999.99) {
            throw new HttpError(422, 'Certains champs sont invalides', 'VALIDATION_ERROR', [['champ' => $champ, 'message' => 'Montant invalide']]);
        }
        $data[$champ] = round((float) $raw, 2);
    }

    $managerId = $in['manager_id'] ?? null;
    $data['manager_id'] = ($managerId === null || $managerId === '') ? null : (int) $managerId;

    $solde = $in['solde_conge_initial'] ?? null;
    if ($solde !== null && $solde !== '' && (!is_numeric($solde) || (float) $solde < 0 || (float) $solde > 365)) {
        throw new HttpError(422, 'Certains champs sont invalides', 'VALIDATION_ERROR', [['champ' => 'solde_conge_initial', 'message' => 'Solde initial invalide (0 à 365 jours)']]);
    }
    $data['solde_conge_initial'] = ($solde === null || $solde === '') ? 0.0 : round((float) $solde, 1);

    return $data;
}

function load_user(int $id): array
{
    return q1('SELECT ' . USER_ADMIN_COLS . ' FROM users WHERE id = ?', [$id]) ?? throw not_found('Collaborateur introuvable');
}

/** Empêche de laisser une société sans aucun RH actif. */
function assert_other_active_rh(int $userId, ?int $companyId): void
{
    $others = (int) q1(
        'SELECT COUNT(*) AS n FROM users WHERE role = ? AND actif = 1 AND id <> ? AND company_id <=> ?',
        [ROLE_RH, $userId, $companyId],
    )['n'];
    if ($others === 0) {
        throw conflict('Impossible : ce compte est le dernier accès RH actif de cette société.');
    }
}

/**
 * Détermine le company_id à appliquer à un collaborateur créé/modifié, selon
 * qui agit : un RH_SOCIETE n'a jamais le choix (toujours sa propre société,
 * jamais celle envoyée dans le corps de la requête) ; un SYSTEM_ADMIN doit
 * désigner explicitement une société existante pour EMPLOYE/RH, DIRECTION
 * reste à portée globale (company_id NULL).
 */
function resolve_company_id(array $me, string $targetRole, mixed $bodyCompanyId): ?int
{
    if ($targetRole === ROLE_DIRECTION) {
        return null;
    }
    if ($me['role'] === ROLE_SYSTEM_ADMIN) {
        $companyId = (int) ($bodyCompanyId ?? 0);
        if (!$companyId || !company_exists($companyId)) {
            throw bad_request('Merci de sélectionner une société valide', [['champ' => 'company_id', 'message' => 'Société invalide ou manquante']]);
        }
        return $companyId;
    }
    return (int) $me['company_id'];
}

/** Colonnes du Module 4 (fiche enrichie) partagées entre la création et la modification. */
function fiche_columns(): array
{
    return ['societe', 'fonction', 'manager_id', 'matricule_paie', 'date_naissance', 'adresse', 'cin',
        'cin_date_delivrance', 'cnss', 'date_embauche', 'date_fin_contrat', 'type_contrat',
        'salaire_base', 'prime', 'indemnite', 'observations_rh'];
}

function insert_collaborateur(array $data): array
{
    $password = temp_password();
    $ficheCols = fiche_columns();
    $cols = array_merge(['matricule', 'nom', 'prenom', 'email', 'telephone', 'service', 'departement', 'site', 'role', 'company_id', 'password', 'solde_conge_initial', 'solde_conge_actuel'], $ficheCols);
    $placeholders = array_fill(0, count($cols), '?');
    $values = [
        $data['matricule'], $data['nom'], $data['prenom'], $data['email'], $data['telephone'],
        $data['service'], $data['departement'], $data['site'], $data['role'], $data['company_id'],
        password_hash($password, PASSWORD_BCRYPT, ['cost' => BCRYPT_COST_TEMP]),
        $data['solde_conge_initial'], $data['solde_conge_initial'], // solde_actuel = solde_initial à la création
        ...array_map(fn ($c) => $data[$c] ?? null, $ficheCols),
    ];
    try {
        $id = tx(function (PDO $pdo) use ($cols, $placeholders, $values, $data) {
            run(
                'INSERT INTO users (' . implode(', ', $cols) . ', mdp_temporaire, actif) VALUES (' . implode(', ', $placeholders) . ', 1, 1)',
                $values,
                $pdo,
            );
            $id = (int) $pdo->lastInsertId();
            // Solde initial historisé (uniquement si non nul, pour ne pas polluer l'historique)
            if ($data['solde_conge_initial'] > 0) {
                run(
                    "INSERT INTO conges_mouvements (user_id, type, jours, solde_apres, commentaire) VALUES (?, 'INITIAL', ?, ?, 'Solde initial à la création du compte')",
                    [$id, $data['solde_conge_initial'], $data['solde_conge_initial']],
                    $pdo,
                );
            }
            return $id;
        });
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict(str_contains($e->getMessage(), 'email')
                ? 'Cette adresse e-mail est déjà utilisée par un autre collaborateur'
                : "Le matricule {$data['matricule']} existe déjà");
        }
        if (str_contains($e->getMessage(), 'fk_users_manager')) {
            throw bad_request('Le manager sélectionné est introuvable');
        }
        throw $e;
    }
    return [$id, $password];
}

// ---------------------------------------------------------------- Liste

route('GET', '/rh/collaborateurs', function () {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    // Isolation par société : un RH_SOCIETE ne voit jamais que sa propre société. Un
    // SYSTEM_ADMIN voit tout, avec un filtre optionnel ?company_id= côté frontend.
    $scopeWhere = [];
    $scopeParams = [];
    if ($me['role'] === ROLE_RH) {
        $scopeWhere[] = 'company_id = ?';
        $scopeParams[] = (int) $me['company_id'];
    } elseif ($cid = qp('company_id')) {
        $scopeWhere[] = 'company_id = ?';
        $scopeParams[] = (int) $cid;
    }

    $where = $scopeWhere;
    $params = $scopeParams;
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
    $scopeWhereSql = $scopeWhere ? 'WHERE ' . implode(' AND ', $scopeWhere) : '';
    $stats = q1(
        "SELECT CAST(COALESCE(SUM(actif = 1), 0) AS SIGNED) AS actifs,
                CAST(COALESCE(SUM(actif = 0), 0) AS SIGNED) AS inactifs,
                CAST(COALESCE(SUM(actif = 1 AND role = 'EMPLOYE'), 0) AS SIGNED) AS employes,
                CAST(COALESCE(SUM(actif = 1 AND role = 'RH'), 0) AS SIGNED) AS rh,
                CAST(COALESCE(SUM(actif = 1 AND role = 'DIRECTION'), 0) AS SIGNED) AS direction,
                CAST(COALESCE(SUM(actif = 1 AND mdp_temporaire = 1), 0) AS SIGNED) AS en_attente_activation
         FROM users $scopeWhereSql",
        $scopeParams,
    );
    json_out(paged(array_map('shape_user', $rows), $total, $pg) + ['stats' => $stats]);
});

// ---------------------------------------------------------------- Création

route('POST', '/rh/collaborateurs', function () {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $data = validate_collaborateur(body());
    $data['company_id'] = resolve_company_id($me, $data['role'], body()['company_id'] ?? null);
    [$id, $password] = insert_collaborateur($data);
    audit('COLLABORATEUR_CREATION', 'users', $id, ['matricule' => $data['matricule'], 'role' => $data['role'], 'company_id' => $data['company_id']]);
    // Le mot de passe provisoire n'est renvoyé qu'une seule fois, ici
    json_out(['data' => shape_user(load_user($id)), 'mot_de_passe_temporaire' => $password], 201);
});

// ---------------------------------------------------------------- Modification (dont le rôle = les accès)

route('PUT', '/rh/collaborateurs/{id}', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $before = load_user($id);
    // IDOR : un RH_SOCIETE ne peut ni voir ni modifier un collaborateur d'une autre société.
    if ($me['role'] === ROLE_RH && (int) $before['company_id'] !== (int) $me['company_id']) {
        throw forbidden();
    }
    $data = validate_collaborateur(body());
    if ($data['manager_id'] === $id) {
        throw bad_request('Un collaborateur ne peut pas être son propre manager');
    }
    $data['company_id'] = $me['role'] === ROLE_SYSTEM_ADMIN
        ? resolve_company_id($me, $data['role'], body()['company_id'] ?? $before['company_id'])
        : $before['company_id']; // Un RH_SOCIETE ne peut jamais changer la société d'un collaborateur

    if ($before['role'] === ROLE_RH && $data['role'] !== ROLE_RH) {
        if ($id === (int) $me['id']) {
            throw conflict('Vous ne pouvez pas retirer votre propre accès RH.');
        }
        assert_other_active_rh($id, $before['company_id']);
    }
    // Le solde de congé n'est JAMAIS modifié ici : il passe par
    // POST /rh/conges/soldes/{userId}/ajustement, seul point d'entrée historisé.
    $ficheCols = fiche_columns();
    $coreCols = ['matricule', 'nom', 'prenom', 'email', 'telephone', 'service', 'departement', 'site', 'role', 'company_id'];
    $allCols = array_merge($coreCols, $ficheCols);
    try {
        run(
            'UPDATE users SET ' . implode(', ', array_map(fn ($c) => "$c = ?", $allCols)) . ' WHERE id = ?',
            [...array_map(fn ($c) => $data[$c] ?? null, $allCols), $id],
        );
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict(str_contains($e->getMessage(), 'email') ? 'Cette adresse e-mail est déjà utilisée' : 'Ce matricule existe déjà');
        }
        if (str_contains($e->getMessage(), 'fk_users_manager')) {
            throw bad_request('Le manager sélectionné est introuvable');
        }
        throw $e;
    }
    $changes = [];
    foreach ($allCols as $k) {
        if ((string) ($before[$k] ?? '') !== (string) ($data[$k] ?? '')) {
            $changes[$k] = ['de' => $before[$k] ?? null, 'vers' => $data[$k] ?? null];
        }
    }
    audit(isset($changes['role']) ? 'COLLABORATEUR_ACCES_MODIFIE' : 'COLLABORATEUR_MODIFICATION', 'users', $id, $changes ?: null);
    json_out(['data' => shape_user(load_user($id))]);
});

// ---------------------------------------------------------------- Activer / désactiver l'accès

route('PATCH', '/rh/collaborateurs/{id}/statut', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $user = load_user($id);
    if ($me['role'] === ROLE_RH && (int) $user['company_id'] !== (int) $me['company_id']) {
        throw forbidden();
    }
    $actif = validator()->bool('actif')->done()['actif'];

    if (!$actif) {
        if ($id === (int) $me['id']) {
            throw conflict('Vous ne pouvez pas désactiver votre propre compte.');
        }
        if ($user['role'] === ROLE_RH) {
            assert_other_active_rh($id, $user['company_id']);
        }
    }
    run('UPDATE users SET actif = ? WHERE id = ?', [$actif ? 1 : 0, $id]);
    // Effet immédiat : chaque requête revérifie en base que le compte est actif
    audit($actif ? 'COLLABORATEUR_REACTIVATION' : 'COLLABORATEUR_DESACTIVATION', 'users', $id, ['matricule' => $user['matricule']]);
    json_out(['data' => shape_user(load_user($id))]);
});

// ---------------------------------------------------------------- Réinitialiser le mot de passe

route('POST', '/rh/collaborateurs/{id}/mot-de-passe', function (array $p) {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $user = load_user($id);
    if ($me['role'] === ROLE_RH && (int) $user['company_id'] !== (int) $me['company_id']) {
        throw forbidden();
    }
    $password = temp_password();
    run('UPDATE users SET password = ?, mdp_temporaire = 1 WHERE id = ?', [password_hash($password, PASSWORD_BCRYPT, ['cost' => BCRYPT_COST_TEMP]), $id]);
    audit('COLLABORATEUR_MDP_REINITIALISE', 'users', $id, ['matricule' => $user['matricule']]);
    json_out(['data' => shape_user(load_user($id)), 'mot_de_passe_temporaire' => $password]);
});

// ---------------------------------------------------------------- Import en masse

route('POST', '/rh/collaborateurs/import', function () {
    $me = require_role(ROLE_RH, ROLE_SYSTEM_ADMIN);
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
            $data['company_id'] = resolve_company_id($me, $data['role'], is_array($ligne) ? ($ligne['company_id'] ?? null) : null);
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
