<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\SiteRequest;
use App\Support\DatabaseError;
use App\Support\Tenant;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/**
 * Sites de la société active (sites.read / sites.manage, appliqués par la RLS de la table sites).
 * Pas de suppression : un site est archivé (archived_at), comme les clients.
 */
class SiteController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $archived = filter_var($request->query('archived', false), FILTER_VALIDATE_BOOLEAN);
        $sql = $archived
            ? 'select * from sites order by code'
            : 'select * from sites where archived_at is null order by code';
        $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select($sql));

        return response()->json(['data' => $rows]);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound();
        }
        $site = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::selectOne('select * from sites where id = ?', [$id]));

        return $site === null ? $this->notFound() : response()->json(['data' => $site]);
    }

    public function store(SiteRequest $request): JsonResponse
    {
        $data = $request->payload();

        try {
            $site = Tenant::run($request->attributes->get('jwt_claims'), function () use ($data) {
                $columns = array_keys($data);
                $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                $row = DB::selectOne(
                    'insert into sites (company_id, '.implode(', ', $columns).") values (private.current_company(), {$placeholders}) returning id",
                    array_values($data),
                );

                return DB::selectOne('select * from sites where id = ?', [$row->id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => $site], Response::HTTP_CREATED)
            ->header('Location', '/api/v1/sites/'.$site->id);
    }

    public function update(SiteRequest $request, string $id): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound();
        }
        $data = $request->payload();
        if ($data === []) {
            return response()->json(['error' => 'EMPTY_UPDATE', 'message' => 'Aucun champ à modifier.'], 422);
        }

        try {
            $site = Tenant::run($request->attributes->get('jwt_claims'), function () use ($id, $data) {
                $sets = implode(', ', array_map(fn ($c) => "{$c} = ?", array_keys($data)));
                $updated = DB::update("update sites set {$sets} where id = ?", array_merge(array_values($data), [$id]));

                return $updated === 0 ? null : DB::selectOne('select * from sites where id = ?', [$id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $site === null ? $this->notFound() : response()->json(['data' => $site]);
    }

    public function archive(Request $request, string $id): JsonResponse
    {
        return $this->setArchived($request, $id, true);
    }

    public function restore(Request $request, string $id): JsonResponse
    {
        return $this->setArchived($request, $id, false);
    }

    private function setArchived(Request $request, string $id, bool $archive): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound();
        }

        try {
            $site = Tenant::run($request->attributes->get('jwt_claims'), function () use ($id, $archive) {
                $updated = DB::update(
                    $archive
                        ? 'update sites set archived_at = now() where id = ? and archived_at is null'
                        : 'update sites set archived_at = null where id = ? and archived_at is not null',
                    [$id],
                );

                return $updated === 0 ? null : DB::selectOne('select * from sites where id = ?', [$id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $site === null ? $this->notFound() : response()->json(['data' => $site]);
    }

    private function isUuid(string $value): bool
    {
        return (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value);
    }

    private function notFound(): JsonResponse
    {
        return response()->json(['error' => 'NOT_FOUND', 'message' => 'Site introuvable ou non autorisé.'], 404);
    }
}
