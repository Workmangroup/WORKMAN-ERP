<?php

namespace Tests\Feature;

use App\Support\DatabaseError;
use Illuminate\Database\QueryException;
use PDOException;
use Tests\TestCase;

class DatabaseErrorTest extends TestCase
{
    /** @return array{0: int, 1: array<string, mixed>} */
    private function map(string $pdoMessage): array
    {
        $response = DatabaseError::response(new QueryException('pgsql', 'select 1', [], new PDOException($pdoMessage)));

        return [$response->getStatusCode(), json_decode($response->getContent(), true)];
    }

    public function test_business_code_raised_by_the_database_is_returned(): void
    {
        [$status, $body] = $this->map("SQLSTATE[55000]: Object not in prerequisite state: 7 ERROR:  CLIENT_NOT_ARCHIVED\nCONTEXT: PL/pgSQL function client_delete(uuid) line 9");

        $this->assertSame(422, $status);
        $this->assertSame('CLIENT_NOT_ARCHIVED', $body['error']);
    }

    public function test_business_code_at_end_of_message_is_returned(): void
    {
        [$status, $body] = $this->map('SQLSTATE[23503]: Foreign key violation: 7 ERROR:  CLIENT_IN_USE');

        $this->assertSame(422, $status);
        $this->assertSame('CLIENT_IN_USE', $body['error']);
    }

    /** Régression : une valeur saisie ne doit jamais devenir le code d'erreur. */
    public function test_user_value_in_database_message_is_not_reflected_as_error_code(): void
    {
        [$status, $body] = $this->map('SQLSTATE[23514]: Check violation: 7 ERROR:  new row for relation "clients" violates check constraint "clients_name_check" DETAIL: Failing row contains (ACMECORP, ...)');

        $this->assertSame(422, $status);
        $this->assertSame('INVALID', $body['error']);
    }

    public function test_uppercase_value_in_sql_text_is_not_a_code(): void
    {
        [$status, $body] = $this->map('SQLSTATE[22P02]: Invalid text representation: 7 ERROR:  invalid input syntax for type uuid: "ACMECORP"');

        $this->assertSame(422, $status);
        $this->assertSame('INVALID', $body['error']);
    }
}
