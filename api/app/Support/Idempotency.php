<?php

namespace App\Support;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

/**
 * Clé d'idempotence (en-tête Idempotency-Key) pour les actions répétables.
 *  - même acteur, même clé, même requête : la réponse enregistrée est renvoyée (en-tête Idempotent-Replayed: true) ;
 *  - même clé avec une autre requête : 422 IDEMPOTENCY_KEY_REUSED ;
 *  - seules les réponses réussies sont enregistrées : un échec peut être repris avec la même clé.
 * La table api_idempotency n'est pas lisible par les utilisateurs (migration 0045) : elle est lue avec la connexion serveur.
 */
final class Idempotency
{
    public static function key(?string $raw): ?string
    {
        $key = trim((string) $raw);

        return ($key !== '' && strlen($key) >= 8 && strlen($key) <= 120) ? $key : null;
    }

    /**
     * @param  array<string, mixed>  $claims
     * @param  array<string, mixed>  $body
     * @param  callable(): JsonResponse  $action
     */
    public static function run(array $claims, string $key, string $method, string $path, array $body, callable $action): JsonResponse
    {
        $actor = (string) ($claims['sub'] ?? '');
        $hash = hash('sha256', $method.' '.$path.' '.json_encode($body, JSON_THROW_ON_ERROR));

        $stored = DB::table('api_idempotency')->where('actor_id', $actor)->where('idem_key', $key)->first();
        if ($stored !== null) {
            if ($stored->request_hash !== $hash) {
                return response()->json(['error' => 'IDEMPOTENCY_KEY_REUSED', 'message' => 'Cette clé a déjà servi pour une autre requête.'], 422);
            }

            return response()->json(json_decode($stored->response_body, true), (int) $stored->response_status)
                ->header('Idempotent-Replayed', 'true');
        }

        $response = $action();
        if ($response->getStatusCode() >= 200 && $response->getStatusCode() < 300) {
            DB::table('api_idempotency')->insert([
                'actor_id' => $actor,
                'idem_key' => $key,
                'request_hash' => $hash,
                'response_status' => $response->getStatusCode(),
                'response_body' => $response->getContent(),
                'created_at' => now(),
            ]);
        }

        return $response;
    }
}
