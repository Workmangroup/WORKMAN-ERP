<?php
declare(strict_types=1);

/*
 * Administration système : gestion des sociétés (Multi-Tenant). Réservé
 * SYSTEM_ADMIN — ce rôle ne réalise aucune opération RH quotidienne.
 */

function shape_company(array $c): array
{
    $c['nb_collaborateurs'] = (int) ($c['nb_collaborateurs'] ?? 0);
    $c['nb_rh'] = (int) ($c['nb_rh'] ?? 0);
    return $c;
}

function load_company(int $id): array
{
    return q1('SELECT * FROM companies WHERE id = ?', [$id]) ?? throw not_found('Société introuvable');
}

function company_exists(int $id): bool
{
    return (bool) q1('SELECT COUNT(*) AS n FROM companies WHERE id = ?', [$id])['n'];
}

function validate_company(array $in): array
{
    $email = trim((string) ($in['email'] ?? ''));
    $v = validator($in)
        ->text('company_name', 2, 120, 'Le nom de la société')
        ->text('legal_name', 0, 180, 'La raison sociale', true)
        ->text('address', 0, 255, "L'adresse", true)
        ->text('city', 0, 80, 'La ville', true)
        ->text('phone', 0, 30, 'Le téléphone', true)
        ->text('tax_number', 0, 40, 'Le matricule fiscal', true)
        ->check($email === '' || filter_var($email, FILTER_VALIDATE_EMAIL) !== false, 'email', 'Adresse e-mail invalide');
    $data = $v->done();
    $data['email'] = $email === '' ? null : mb_strtolower($email);
    return $data;
}

// ---------------------------------------------------------------- Liste

route('GET', '/admin/societes', function () {
    require_role(ROLE_SYSTEM_ADMIN);
    $rows = q(
        "SELECT c.*,
                (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.actif = 1) AS nb_collaborateurs,
                (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.role = 'RH' AND u.actif = 1) AS nb_rh
         FROM companies c ORDER BY c.company_name",
    );
    json_out(['data' => array_map('shape_company', $rows)]);
});

// ---------------------------------------------------------------- Création

route('POST', '/admin/societes', function () {
    require_role(ROLE_SYSTEM_ADMIN);
    $in = body();
    $code = mb_strtoupper(trim((string) ($in['company_code'] ?? '')));
    if ($code === '' || mb_strlen($code) < 2 || mb_strlen($code) > 20 || !preg_match('/^[A-Z0-9_-]+$/', $code)) {
        throw bad_request('Code société invalide', [['champ' => 'company_code', 'message' => 'Le code doit contenir 2 à 20 lettres, chiffres, tirets, sans espace']]);
    }
    $data = validate_company($in);

    try {
        $id = (int) tx(function (PDO $pdo) use ($code, $data) {
            run(
                'INSERT INTO companies (company_code, company_name, legal_name, address, city, phone, email, tax_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [$code, $data['company_name'], $data['legal_name'], $data['address'], $data['city'], $data['phone'], $data['email'], $data['tax_number']],
                $pdo,
            );
            return $pdo->lastInsertId();
        });
    } catch (Throwable $e) {
        if (is_duplicate($e)) {
            throw conflict("Le code société « $code » existe déjà");
        }
        throw $e;
    }
    audit('SOCIETE_CREATION', 'companies', $id, ['company_code' => $code]);
    json_out(['data' => shape_company(load_company($id) + ['nb_collaborateurs' => 0, 'nb_rh' => 0])], 201);
});

// ---------------------------------------------------------------- Modification (dont activation / désactivation)

route('PATCH', '/admin/societes/{id}', function (array $p) {
    require_role(ROLE_SYSTEM_ADMIN);
    $id = (int) $p['id'];
    $before = load_company($id);
    $in = body();
    $data = validate_company($in);
    $status = (string) ($in['status'] ?? $before['status']);
    if (!in_array($status, ['ACTIVE', 'INACTIVE'], true)) {
        throw bad_request('Statut invalide', [['champ' => 'status', 'message' => 'Statut invalide']]);
    }

    run(
        'UPDATE companies SET company_name = ?, legal_name = ?, address = ?, city = ?, phone = ?, email = ?, tax_number = ?, status = ? WHERE id = ?',
        [$data['company_name'], $data['legal_name'], $data['address'], $data['city'], $data['phone'], $data['email'], $data['tax_number'], $status, $id],
    );
    if ($status !== $before['status']) {
        audit('SOCIETE_STATUT', 'companies', $id, ['de' => $before['status'], 'vers' => $status]);
    } else {
        audit('SOCIETE_MODIFICATION', 'companies', $id);
    }
    $updated = load_company($id);
    $updated['nb_collaborateurs'] = (int) q1('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND actif = 1', [$id])['n'];
    $updated['nb_rh'] = (int) q1("SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'RH' AND actif = 1", [$id])['n'];
    json_out(['data' => shape_company($updated)]);
});
