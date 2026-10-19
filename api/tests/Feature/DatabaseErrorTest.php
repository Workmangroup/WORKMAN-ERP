<?php

namespace Tests\Feature;

use App\Support\DatabaseError;
use Illuminate\Database\QueryException;
use PDOException;
use Tests\TestCase;

class DatabaseErrorTest extends TestCase
{
    /** @return iterable<string, array{0: string, 1: string}> message PDO, code attendu */
    public static function messages(): iterable
    {
        yield 'code suivi de CONTEXT' => ["SQLSTATE[55000]: Object not in prerequisite state: 7 ERROR:  CLIENT_NOT_ARCHIVED\nCONTEXT: PL/pgSQL function client_delete(uuid) line 9", 'CLIENT_NOT_ARCHIVED'];
        yield 'code en fin de message' => ['SQLSTATE[23503]: Foreign key violation: 7 ERROR:  CLIENT_IN_USE', 'CLIENT_IN_USE'];
        // Régression : une valeur saisie ne doit jamais devenir le code d'erreur.
        yield 'valeur saisie dans DETAIL' => ['SQLSTATE[23514]: Check violation: 7 ERROR:  new row for relation "clients" violates check constraint "clients_name_check" DETAIL: Failing row contains (ACMECORP, ...)', 'INVALID'];
        yield 'valeur saisie dans une erreur de type' => ['SQLSTATE[22P02]: Invalid text representation: 7 ERROR:  invalid input syntax for type uuid: "ACMECORP"', 'INVALID'];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('messages')]
    public function test_only_a_raised_business_code_is_returned(string $pdoMessage, string $expectedCode): void
    {
        $response = DatabaseError::response(new QueryException('pgsql', 'select 1', [], new PDOException($pdoMessage)));

        $this->assertSame(422, $response->getStatusCode());
        $this->assertSame($expectedCode, json_decode($response->getContent(), true)['error']);
    }
}
