<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Support\DatabaseError;
use App\Support\Tenant;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/** Notifications internes de l'utilisateur connecté. La base ne renvoie que les siennes (RLS). */
class NotificationController extends Controller
{
    private const PAGE_SIZE = 25;

    /** GET /api/v1/notifications?page=&per_page=&unread=1 — ETag : 304 si rien n'a changé. */
    public function index(Request $request): JsonResponse|Response
    {
        $claims = $request->attributes->get('jwt_claims');
        $page = max((int) $request->query('page', 1), 1);
        $perPage = min(max((int) $request->query('per_page', self::PAGE_SIZE), 1), 100);
        $unread = $request->query('unread') === '1';

        try {
            $result = Tenant::run($claims, function () use ($page, $perPage, $unread) {
                $base = DB::table('notifications')->when($unread, fn ($q) => $q->whereNull('read_at'));
                $total = (clone $base)->count();
                $rows = (clone $base)
                    ->select(['id', 'kind', 'title', 'body', 'link', 'created_at', 'read_at'])
                    ->orderByDesc('created_at')->orderBy('id')
                    ->forPage($page, $perPage)->get()->map(fn ($r) => (array) $r)->all();

                return ['data' => $rows, 'meta' => ['page' => $page, 'per_page' => $perPage, 'total' => $total]];
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        $etag = '"'.sha1(json_encode($result, JSON_THROW_ON_ERROR)).'"';
        if ($request->header('If-None-Match') === $etag) {
            return response('', 304)->header('ETag', $etag);
        }

        return response()->json($result)->header('ETag', $etag);
    }

    /** POST /api/v1/notifications/{id}/read — 204 ; 404 si la notification n'est pas la sienne. */
    public function markRead(Request $request, string $id): JsonResponse|Response
    {
        if (! preg_match('/^[0-9a-f-]{36}$/i', $id)) {
            return response()->json(['error' => 'INVALID_ID', 'message' => 'Identifiant invalide.'], 422);
        }
        try {
            Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select('select public.notification_mark_read(?)', [$id]));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->noContent();
    }
}
