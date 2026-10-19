<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Http\Requests\ClientRequest;
use App\Support\DatabaseError;
use App\Support\Tenant;
use Illuminate\Database\Query\Builder;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\Response;

class ClientController extends Controller
{
    private const LIST_COLUMNS = 'id, code, name, legal_name, tax_id, country, currency, language, email, phone, payment_terms_id, sales_rep_id, vat_exempt, archived_at, created_at, updated_at';
    private const PAGE_SIZE = 25;
    private const SORTS = ['name' => 'name', 'code' => 'code', 'recent' => 'created_at', 'updated' => 'updated_at'];

    /** Liste paginée des clients, avec les mêmes filtres et tris que l'écran Clients (droit clients.read via RLS). */
    public function index(Request $request): JsonResponse
    {
        $claims = $request->attributes->get('jwt_claims');
        $page = max((int) $request->query('page', 1), 1);
        $perPage = min(max((int) $request->query('per_page', self::PAGE_SIZE), 1), 100);
        $status = in_array($request->query('status'), ['active', 'archived', 'all'], true) ? $request->query('status') : 'active';
        $sort = self::SORTS[$request->query('sort', 'name')] ?? 'name';
        $term = $this->cleanText($request->query('q'), 80);
        $country = $this->code($request->query('country'), 2);
        $currency = $this->code($request->query('currency'), 3);
        $terms = $this->uuidOrNull($request->query('terms'));
        $rep = $request->query('rep');

        $result = Tenant::run($claims, function () use ($page, $perPage, $status, $sort, $term, $country, $currency, $terms, $rep) {
            $apply = function (Builder $q) use ($status, $term, $country, $currency, $terms, $rep) {
                if ($status === 'active') {
                    $q->whereNull('archived_at');
                } elseif ($status === 'archived') {
                    $q->whereNotNull('archived_at');
                }
                if ($term !== '') {
                    $like = '%'.addcslashes($term, '%_\\').'%';
                    $q->where(function (Builder $w) use ($like) {
                        foreach (['name', 'legal_name', 'code', 'tax_id', 'email', 'phone'] as $col) {
                            $w->orWhere($col, 'ilike', $like);
                        }
                    });
                }
                if ($country !== null) {
                    $q->where('country', $country);
                }
                if ($currency !== null) {
                    $q->where('currency', $currency);
                }
                if ($terms !== null) {
                    $q->where('payment_terms_id', $terms);
                }
                if ($rep === 'none') {
                    $q->whereNull('sales_rep_id');
                } elseif ($this->uuidOrNull($rep) !== null) {
                    $q->where('sales_rep_id', $rep);
                }

                return $q;
            };

            $total = $apply(DB::table('clients'))->count();
            $rows = $apply(DB::table('clients'))
                ->selectRaw(self::LIST_COLUMNS)
                ->orderBy($sort)
                ->orderBy('id')
                ->forPage($page, $perPage)
                ->get()
                ->map(fn ($r) => (array) $r)
                ->all();

            // Contact principal de chaque client de la page (RLS de client_contacts appliquée).
            $primary = [];
            $ids = array_column($rows, 'id');
            if ($ids !== []) {
                foreach (DB::table('client_contacts')->select('client_id', 'full_name', 'email', 'phone')
                    ->whereIn('client_id', $ids)->where('is_primary', true)->get() as $c) {
                    $primary[$c->client_id] = ['full_name' => $c->full_name, 'email' => $c->email, 'phone' => $c->phone];
                }
            }
            foreach ($rows as &$row) {
                $row['primary_contact'] = $primary[$row['id']] ?? null;
            }
            unset($row);

            return [
                'rows' => $rows,
                'total' => $total,
                'counts' => [
                    'active' => DB::table('clients')->whereNull('archived_at')->count(),
                    'archived' => DB::table('clients')->whereNotNull('archived_at')->count(),
                ],
                'facets' => [
                    'countries' => DB::table('clients')->distinct()->orderBy('country')->pluck('country')->values()->all(),
                    'currencies' => DB::table('clients')->distinct()->orderBy('currency')->pluck('currency')->values()->all(),
                ],
            ];
        });

        return response()->json([
            'data' => $result['rows'],
            'meta' => [
                'page' => $page,
                'per_page' => $perPage,
                'total' => $result['total'],
                'counts' => $result['counts'],
                'facets' => $result['facets'],
            ],
        ]);
    }

    /** Fiche d'un client (tous les champs). */
    public function show(Request $request, string $id): JsonResponse
    {
        if ($this->uuidOrNull($id) === null) {
            return $this->notFound();
        }
        $client = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::selectOne('select * from clients where id = ?', [$id]));

        return $client === null ? $this->notFound() : response()->json(['data' => $client]);
    }

    /** Création d'un client. Le numéro (code) est attribué par la base s'il n'est pas fourni. */
    public function store(ClientRequest $request): JsonResponse
    {
        $data = $this->payload($request);

        try {
            $client = Tenant::run($request->attributes->get('jwt_claims'), function () use ($data) {
                $columns = array_keys($data);
                $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                $row = DB::selectOne(
                    'insert into clients ('.implode(', ', $columns).") values ({$placeholders}) returning id",
                    array_values($data),
                );

                return DB::selectOne('select * from clients where id = ?', [$row->id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => $client], Response::HTTP_CREATED)
            ->header('Location', '/api/v1/clients/'.$client->id);
    }

    /** Modification partielle d'un client : seuls les champs envoyés changent. */
    public function update(ClientRequest $request, string $id): JsonResponse
    {
        if ($this->uuidOrNull($id) === null) {
            return $this->notFound();
        }
        $data = $this->payload($request);
        if ($data === []) {
            return response()->json(['error' => 'EMPTY_UPDATE', 'message' => 'Aucun champ à modifier.'], 422);
        }

        try {
            $client = Tenant::run($request->attributes->get('jwt_claims'), function () use ($id, $data) {
                $sets = implode(', ', array_map(fn ($c) => "{$c} = ?", array_keys($data)));
                // updated_at est géré par le déclencheur de la table (0004), pas par l'API.
                $updated = DB::update("update clients set {$sets} where id = ? and archived_at is null", array_merge(array_values($data), [$id]));
                if ($updated === 0) {
                    return null;
                }

                return DB::selectOne('select * from clients where id = ?', [$id]);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return $client === null ? $this->notFound() : response()->json(['data' => $client]);
    }

    /** Archivage avec motif facultatif (clients.delete). */
    public function archive(Request $request, string $id): JsonResponse
    {
        if ($this->uuidOrNull($id) === null) {
            return $this->notFound();
        }
        $reason = $this->cleanText($request->input('reason'), 300);
        try {
            Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select('select client_archive(?, ?)', [$id, $reason !== '' ? $reason : null]));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => ['id' => $id, 'archived' => true]]);
    }

    /** Restauration d'un client archivé (clients.delete). */
    public function restore(Request $request, string $id): JsonResponse
    {
        if ($this->uuidOrNull($id) === null) {
            return $this->notFound();
        }
        try {
            Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select('select client_restore(?)', [$id]));
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        return response()->json(['data' => ['id' => $id, 'archived' => false]]);
    }

    /**
     * Suppression définitive (clients.delete, confirmation « SUPPRIMER » obligatoire).
     * Renvoie les fichiers GED à retirer du stockage : le serveur web les supprime après l'API.
     */
    public function destroy(Request $request, string $id): JsonResponse
    {
        if ($this->uuidOrNull($id) === null) {
            return $this->notFound();
        }
        if (strtoupper(trim((string) $request->input('confirm'))) !== 'SUPPRIMER') {
            return response()->json(['error' => 'CONFIRMATION_REQUIRED', 'message' => 'Confirmation « SUPPRIMER » requise.'], 422);
        }

        try {
            $result = Tenant::run($request->attributes->get('jwt_claims'), function () use ($id) {
                $row = DB::selectOne('select client_delete(?) as result', [$id]);

                return json_decode($row->result, true, 512, JSON_THROW_ON_ERROR);
            });
        } catch (QueryException $e) {
            return DatabaseError::response($e);
        }

        $files = array_map(fn ($f) => ['bucket' => $f['bucket'], 'path' => $f['path']], $result['files'] ?? []);

        return response()->json(['data' => ['id' => $id, 'deleted' => true, 'storage' => $files]]);
    }

    /** Champs écrits, sans valeurs absentes ; les chaînes vides deviennent null. */
    private function payload(ClientRequest $request): array
    {
        $data = Arr::only($request->validated(), ClientRequest::writable());
        foreach ($data as $key => $value) {
            if ($value === '') {
                $data[$key] = null;
            }
            if ($key === 'code' && $value === null) {
                unset($data[$key]);
            }
        }

        return $data;
    }

    private function notFound(): JsonResponse
    {
        return response()->json(['error' => 'NOT_FOUND', 'message' => 'Client introuvable ou non autorisé.'], 404);
    }

    /** Texte libre : caractères de contrôle et espaces superflus retirés, longueur bornée. */
    private function cleanText(mixed $value, int $max): string
    {
        $text = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', (string) $value) ?? '';

        return mb_substr(trim(preg_replace('/\s+/u', ' ', $text) ?? ''), 0, $max);
    }

    private function code(mixed $value, int $length): ?string
    {
        $code = strtoupper(trim((string) $value));

        return preg_match('/^[A-Z]{'.$length.'}$/', $code) ? $code : null;
    }

    private function uuidOrNull(mixed $value): ?string
    {
        $v = trim((string) $value);

        return preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $v) ? $v : null;
    }
}
