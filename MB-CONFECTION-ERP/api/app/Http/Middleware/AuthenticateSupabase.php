<?php

namespace App\Http\Middleware;

use App\Auth\SupabaseToken;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Exige un jeton Supabase valide (en-tête Authorization: Bearer). Sans jeton valide : 401. */
class AuthenticateSupabase
{
    public function handle(Request $request, Closure $next): Response
    {
        $raw = $request->bearerToken();
        if ($raw === null || $raw === '') {
            return response()->json(['error' => 'UNAUTHENTICATED', 'message' => 'Jeton manquant.'], 401);
        }

        try {
            $claims = SupabaseToken::verify($raw);
        } catch (\Throwable) {
            return response()->json(['error' => 'UNAUTHENTICATED', 'message' => 'Jeton invalide ou expiré.'], 401);
        }

        $request->attributes->set('jwt_claims', $claims);

        return $next($request);
    }
}
