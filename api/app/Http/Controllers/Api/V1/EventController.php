<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Support\DatabaseError;
use App\Support\Idempotency;
use App\Support\Tenant;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Événements : échecs visibles, passe de traitement, replay. Droits appliqués par la base (events.read / events.replay). */
class EventController extends Controller
{
    private const CONSUMERS = ['notify_internal'];

    /** GET /api/v1/events/failures?limit= — échecs et événements morts, avec leur cause. */
    public function failures(Request $request): JsonResponse
    {
        $limit = min(max((int) $request->query('limit', 100), 1), 500);
        try {
            $rows = Tenant::run($request->attributes->get('jwt_claims'),
                fn () => DB::select('select * from public.event_failures(?)', [$limit]));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => array_map(fn ($r) => (array) $r, $rows)]);
    }

    /** POST /api/v1/events/dispatch — relance les consommateurs sur les événements non traités. Sans effet double. */
    public function dispatch(Request $request): JsonResponse
    {
        try {
            $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select('select public.event_dispatch(500) r'));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => json_decode($rows[0]->r, true)]);
    }

    /**
     * POST /api/v1/events/{id}/replay — body: { "consumer": "notify_internal" }. En-tête Idempotency-Key obligatoire.
     * Résultat : done | already_done | failed | dead.
     */
    public function replay(Request $request, string $id): JsonResponse
    {
        if (! preg_match('/^[0-9a-f-]{36}$/i', $id)) {
            return response()->json(['error' => 'INVALID_ID', 'message' => 'Identifiant invalide.'], 422);
        }
        $key = Idempotency::key($request->header('Idempotency-Key'));
        if ($key === null) {
            return response()->json(['error' => 'IDEMPOTENCY_KEY_REQUIRED', 'message' => 'En-tête Idempotency-Key requis (8 à 120 caractères).'], 422);
        }
        $consumer = (string) $request->input('consumer', '');
        if (! in_array($consumer, self::CONSUMERS, true)) {
            return response()->json(['error' => 'EVENT_CONSUMER_UNKNOWN', 'message' => 'Consommateur inconnu.'], 422);
        }

        $claims = $request->attributes->get('jwt_claims');

        return Idempotency::run($claims, $key, 'POST', "/api/v1/events/{$id}/replay", $request->all(),
            function () use ($claims, $id, $consumer) {
                try {
                    $res = Tenant::run($claims, fn () => DB::select('select public.event_replay(?, ?) r', [$id, $consumer]));
                } catch (QueryException $e) {
                    return DatabaseError::response($e);
                }

                return response()->json(['data' => ['event_id' => $id, 'consumer' => $consumer, 'result' => $res[0]->r]]);
            });
    }
}
