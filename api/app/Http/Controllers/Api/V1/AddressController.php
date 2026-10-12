<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\AddressRequest;
use App\Support\DatabaseError;
use App\Support\Tenant;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/** Adresses d'un client (clients.read / clients.write, appliqués par la RLS). */
class AddressController extends Controller
{
    public function index(Request $request, string $client): JsonResponse
    {
        if (! $this->isUuid($client)) {
            return $this->notFound('Client introuvable ou non autorisé.');
        }
        $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select(
            'select * from client_addresses where client_id = ? order by type, is_default desc, city', [$client],
        ));

        return response()->json(['data' => $rows]);
    }

    public function store(AddressRequest $request, string $client): JsonResponse
    {
        if (! $this->isUuid($client)) {
            return $this->notFound('Client introuvable ou non autorisé.');
        }
        $data = ['client_id' => $client] + $request->payload();

        try {
            $address = Tenant::run($request->attributes->get('jwt_claims'), function () use ($data) {
                $columns = array_keys($data);
                $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                $row = DB::selectOne(
                    'insert into client_addresses ('.implode(', ', $columns).") values ({$placeholders}) returning id",
                    array_values($data),
                );

                return DB::selectOne('select * from client_addresses where id = ?', [$row->id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => $address], Response::HTTP_CREATED)
            ->header('Location', '/api/v1/addresses/'.$address->id);
    }

    public function update(AddressRequest $request, string $id): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound('Adresse introuvable ou non autorisée.');
        }
        $data = $request->payload();
        if ($data === []) {
            return response()->json(['error' => 'EMPTY_UPDATE', 'message' => 'Aucun champ à modifier.'], 422);
        }

        try {
            $address = Tenant::run($request->attributes->get('jwt_claims'), function () use ($id, $data) {
                $sets = implode(', ', array_map(fn ($c) => "{$c} = ?", array_keys($data)));
                $updated = DB::update("update client_addresses set {$sets} where id = ?", array_merge(array_values($data), [$id]));

                return $updated === 0 ? null : DB::selectOne('select * from client_addresses where id = ?', [$id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $address === null
            ? $this->notFound('Adresse introuvable ou non autorisée.')
            : response()->json(['data' => $address]);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound('Adresse introuvable ou non autorisée.');
        }

        try {
            $deleted = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::delete('delete from client_addresses where id = ?', [$id]));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $deleted === 0
            ? $this->notFound('Adresse introuvable ou non autorisée.')
            : response()->json(['data' => ['id' => $id, 'deleted' => true]]);
    }

    private function isUuid(string $value): bool
    {
        return (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $value);
    }

    private function notFound(string $message): JsonResponse
    {
        return response()->json(['error' => 'NOT_FOUND', 'message' => $message], 404);
    }
}
