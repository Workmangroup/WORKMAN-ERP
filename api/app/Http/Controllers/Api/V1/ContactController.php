<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\ContactRequest;
use App\Support\DatabaseError;
use App\Support\Tenant;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

/** Contacts d'un client (clients.read / clients.write, appliqués par la RLS). */
class ContactController extends Controller
{
    public function index(Request $request, string $client): JsonResponse
    {
        if (! $this->isUuid($client)) {
            return $this->notFound('Client introuvable ou non autorisé.');
        }
        $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select(
            'select * from client_contacts where client_id = ? order by is_primary desc, full_name', [$client],
        ));

        return response()->json(['data' => $rows]);
    }

    public function store(ContactRequest $request, string $client): JsonResponse
    {
        if (! $this->isUuid($client)) {
            return $this->notFound('Client introuvable ou non autorisé.');
        }
        $data = ['client_id' => $client] + $request->payload();

        try {
            $contact = Tenant::run($request->attributes->get('jwt_claims'), function () use ($data) {
                $columns = array_keys($data);
                $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                $row = DB::selectOne(
                    'insert into client_contacts ('.implode(', ', $columns).") values ({$placeholders}) returning id",
                    array_values($data),
                );

                return DB::selectOne('select * from client_contacts where id = ?', [$row->id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => $contact], Response::HTTP_CREATED)
            ->header('Location', '/api/v1/contacts/'.$contact->id);
    }

    public function update(ContactRequest $request, string $id): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound('Contact introuvable ou non autorisé.');
        }
        $data = $request->payload();
        if ($data === []) {
            return response()->json(['error' => 'EMPTY_UPDATE', 'message' => 'Aucun champ à modifier.'], 422);
        }

        try {
            $contact = Tenant::run($request->attributes->get('jwt_claims'), function () use ($id, $data) {
                $sets = implode(', ', array_map(fn ($c) => "{$c} = ?", array_keys($data)));
                $updated = DB::update("update client_contacts set {$sets} where id = ?", array_merge(array_values($data), [$id]));

                return $updated === 0 ? null : DB::selectOne('select * from client_contacts where id = ?', [$id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $contact === null
            ? $this->notFound('Contact introuvable ou non autorisé.')
            : response()->json(['data' => $contact]);
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        if (! $this->isUuid($id)) {
            return $this->notFound('Contact introuvable ou non autorisé.');
        }

        try {
            $deleted = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::delete('delete from client_contacts where id = ?', [$id]));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $deleted === 0
            ? $this->notFound('Contact introuvable ou non autorisé.')
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
