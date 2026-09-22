<?php
declare(strict_types=1);

function pdo_connect(string $user, string $password): PDO
{
    $dsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', CFG['db_host'], CFG['db_port'], CFG['db_name']);
    $pdo = new PDO($dsn, $user, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        // Requêtes préparées côté serveur : entiers renvoyés en int, protection contre l'injection SQL
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
    $pdo->exec("SET time_zone = " . $pdo->quote(CFG['timezone']));
    return $pdo;
}

/** Connexion principale. */
function db(): PDO
{
    static $pdo = null;
    return $pdo ??= pdo_connect(CFG['db_user'], CFG['db_password']);
}

/** Connexion Direction : compte restreint aux vues anonymisées s'il est configuré. */
function db_direction(): PDO
{
    static $pdo = null;
    if (CFG['db_direction_user'] === '') {
        return db();
    }
    return $pdo ??= pdo_connect(CFG['db_direction_user'], CFG['db_direction_password']);
}

/** Exécute une requête paramétrée et renvoie toutes les lignes. */
function q(string $sql, array $params = [], ?PDO $pdo = null): array
{
    $st = ($pdo ?? db())->prepare($sql);
    $st->execute(array_values($params));
    return $st->fetchAll();
}

/** Première ligne ou null. */
function q1(string $sql, array $params = [], ?PDO $pdo = null): ?array
{
    $rows = q($sql, $params, $pdo);
    return $rows[0] ?? null;
}

/** INSERT / UPDATE / DELETE ; renvoie le PDOStatement. */
function run(string $sql, array $params = [], ?PDO $pdo = null): PDOStatement
{
    $st = ($pdo ?? db())->prepare($sql);
    $st->execute(array_values($params));
    return $st;
}

/** « ?, ?, ? » pour une clause IN. */
function placeholders(array $values): string
{
    return implode(', ', array_fill(0, max(1, count($values)), '?'));
}

/** Exécute $fn dans une transaction (rollback automatique en cas d'erreur). */
function tx(callable $fn): mixed
{
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $result = $fn($pdo);
        $pdo->commit();
        return $result;
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

/** Code d'erreur MySQL de doublon (clé unique). */
function is_duplicate(Throwable $e): bool
{
    return $e instanceof PDOException && (int) ($e->errorInfo[1] ?? 0) === 1062;
}

/** Numéro de ticket atomique : DEM-2026-0001 (LAST_INSERT_ID(expr) évite toute collision). */
function next_numero(PDO $pdo, string $prefixe): string
{
    $annee = (int) date('Y');
    run(
        'INSERT INTO sequences (prefixe, annee, dernier) VALUES (?, ?, LAST_INSERT_ID(1))
         ON DUPLICATE KEY UPDATE dernier = LAST_INSERT_ID(dernier + 1)',
        [$prefixe, $annee],
        $pdo,
    );
    $n = (int) $pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn();
    return sprintf('%s-%d-%04d', $prefixe, $annee, $n);
}

/** Moyenne SQL (DECIMAL renvoyé en texte) → float arrondi, ou null. */
function fnum(mixed $v, int $precision = 1): ?float
{
    return $v === null ? null : round((float) $v, $precision);
}
