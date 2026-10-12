<?php

namespace App\Auth;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Lcobucci\Clock\SystemClock;
use Lcobucci\JWT\Encoding\JoseEncoder;
use Lcobucci\JWT\Signer\Ecdsa\Sha256 as EcdsaSha256;
use Lcobucci\JWT\Signer\Hmac\Sha256 as HmacSha256;
use Lcobucci\JWT\Signer\Key\InMemory;
use Lcobucci\JWT\Token\Parser;
use Lcobucci\JWT\UnencryptedToken;
use Lcobucci\JWT\Validation\Constraint\SignedWith;
use Lcobucci\JWT\Validation\Constraint\LooseValidAt;
use Lcobucci\JWT\Validation\Validator;
use RuntimeException;

/**
 * Vérifie les jetons d'accès émis par Supabase Auth.
 *  - ES256 (clés de signature asymétriques, usage actuel) : clé publique lue dans le JWKS de Supabase, mise en cache.
 *  - HS256 (ancien mode) : secret partagé SUPABASE_JWT_SECRET.
 * L'API ne crée aucun compte : l'identité est celle de Supabase, les droits sont ceux de la base (RLS).
 */
final class SupabaseToken
{
    /** @return array<string, mixed> claims du jeton vérifié */
    public static function verify(string $raw): array
    {
        $token = (new Parser(new JoseEncoder()))->parse($raw);
        if (! $token instanceof UnencryptedToken) {
            throw new RuntimeException('Jeton non reconnu.');
        }

        $alg = $token->headers()->get('alg');
        $kid = $token->headers()->get('kid');

        $constraints = [new LooseValidAt(SystemClock::fromUTC())];
        if ($alg === 'ES256') {
            $pem = self::publicKeyPem((string) $kid);
            $constraints[] = new SignedWith(new EcdsaSha256(), InMemory::plainText($pem));
        } elseif ($alg === 'HS256') {
            $secret = (string) config('services.supabase.jwt_secret');
            if (strlen($secret) < 32) {
                throw new RuntimeException('SUPABASE_JWT_SECRET absent ou trop court.');
            }
            $constraints[] = new SignedWith(new HmacSha256(), InMemory::plainText($secret));
        } else {
            throw new RuntimeException('Algorithme non autorisé.');
        }

        if (! (new Validator())->validate($token, ...$constraints)) {
            throw new RuntimeException('Signature ou date invalide.');
        }

        $claims = $token->claims()->all();
        if (($claims['role'] ?? null) !== 'authenticated') {
            throw new RuntimeException('Rôle non autorisé.');
        }

        return array_map(
            static fn ($v) => $v instanceof \DateTimeImmutable ? $v->getTimestamp() : $v,
            $claims,
        );
    }

    /** Clé publique PEM correspondant au kid, lue dans le JWKS de Supabase (cache 10 minutes). */
    private static function publicKeyPem(string $kid): string
    {
        $url = rtrim((string) config('services.supabase.url'), '/').'/auth/v1/.well-known/jwks.json';
        $jwks = Cache::remember('supabase.jwks', 600, function () use ($url) {
            return Http::timeout(5)->get($url)->throw()->json();
        });

        foreach ($jwks['keys'] ?? [] as $key) {
            if (($key['kid'] ?? null) === $kid && ($key['kty'] ?? null) === 'EC' && ($key['crv'] ?? null) === 'P-256') {
                $x = self::pad(self::b64url($key['x']));
                $y = self::pad(self::b64url($key['y']));
                // SubjectPublicKeyInfo pour EC P-256 + point non compressé (0x04 || x || y)
                $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200').chr(4).$x.$y;

                return "-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($der), 64, "\n")."-----END PUBLIC KEY-----\n";
            }
        }

        throw new RuntimeException('Clé de signature inconnue.');
    }

    private static function b64url(string $value): string
    {
        return base64_decode(strtr($value, '-_', '+/').str_repeat('=', (4 - strlen($value) % 4) % 4), true) ?: '';
    }

    private static function pad(string $bytes): string
    {
        return str_pad($bytes, 32, "\0", STR_PAD_LEFT);
    }
}
