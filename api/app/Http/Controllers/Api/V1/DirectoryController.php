<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Support\Tenant;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/** Listes de référence : conditions de paiement, commerciaux, annuaire des utilisateurs de la société. */
class DirectoryController extends Controller
{
    /** Conditions de paiement actives, dans l'ordre d'affichage. */
    public function paymentTerms(Request $request): JsonResponse
    {
        $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select(
            'select id, code, label, days, end_of_month from payment_terms where is_active = true order by sort_order',
        ));

        return response()->json(['data' => $rows]);
    }

    /** Utilisateurs pouvant être affectés comme commercial (détenteurs de clients.write). */
    public function salesReps(Request $request): JsonResponse
    {
        $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select('select * from client_sales_reps()'));

        return response()->json(['data' => $rows]);
    }

    /** Noms et e-mails d'utilisateurs de la société : ?ids=uuid1,uuid2 (au plus 100). */
    public function users(Request $request): JsonResponse
    {
        $ids = array_values(array_unique(array_filter(
            array_map('trim', explode(',', (string) $request->query('ids', ''))),
            fn ($id) => (bool) preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id),
        )));
        if ($ids === []) {
            return response()->json(['data' => []]);
        }
        $ids = array_slice($ids, 0, 100);
        $placeholders = implode(', ', array_fill(0, count($ids), '?'));

        $rows = Tenant::run($request->attributes->get('jwt_claims'), fn () => DB::select(
            "select id, full_name, email from company_directory where id in ({$placeholders})", $ids,
        ));

        return response()->json(['data' => $rows]);
    }
}
