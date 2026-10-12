<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;

/**
 * Exécute une requête SQL au nom de l'utilisateur : les règles d'accès (RLS) de PostgreSQL
 * s'appliquent comme pour Supabase. Le contexte est local à la transaction : rien ne fuit entre requêtes.
 */
final class Tenant
{
    /**
     * @param  array<string, mixed>  $claims
     * @param  callable(): mixed  $callback
     */
    public static function run(array $claims, callable $callback): mixed
    {
        return DB::transaction(function () use ($claims, $callback) {
            DB::statement("select set_config('request.jwt.claims', ?, true)", [json_encode($claims, JSON_THROW_ON_ERROR)]);
            DB::statement('set local role authenticated');

            return $callback();
        });
    }
}
