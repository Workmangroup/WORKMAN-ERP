<?php

namespace App\Support;

use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;

/**
 * Traduit une erreur PostgreSQL en réponse HTTP, sans révéler de détail interne.
 *  - droit insuffisant (RBAC_FORBIDDEN, row-level security) → 403
 *  - élément absent (P0002, *_NOT_FOUND) → 404
 *  - doublon (unique) → 409
 *  - règle métier refusée (55000, 22023, codes métier) → 422 avec le code métier
 */
final class DatabaseError
{
    public static function response(QueryException $e): JsonResponse
    {
        $message = $e->getMessage();

        if (str_contains($message, 'RBAC_FORBIDDEN') || str_contains($message, 'row-level security')) {
            return response()->json(['error' => 'FORBIDDEN', 'message' => 'Droit insuffisant.'], 403);
        }
        if (str_contains($message, 'NOT_FOUND')) {
            return response()->json(['error' => 'NOT_FOUND', 'message' => 'Élément introuvable ou non accessible.'], 404);
        }
        if (str_contains($message, 'duplicate key') || str_contains($message, 'unique constraint')) {
            return response()->json(['error' => 'CONFLICT', 'message' => 'Cette valeur existe déjà.'], 409);
        }
        // Code métier après « ERROR: », suivi d'un retour à la ligne, de « (Connection: » ou de la fin du message.
        // Pas de repli : le message peut contenir des valeurs saisies.
        if (preg_match('/ERROR:\s+([A-Z][A-Z0-9_]{3,})(?=\s*(?:\R|\(Connection:|$))/', $message, $m)) {
            return response()->json(['error' => $m[1], 'message' => 'Opération refusée : '.$m[1].'.'], 422);
        }

        return response()->json(['error' => 'INVALID', 'message' => 'Données refusées par la base.'], 422);
    }
}
