<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

/**
 * Validation d'un client (création et modification). Mêmes règles que le formulaire web (features/clients/schemas.ts).
 * En modification, seuls les champs envoyés sont contrôlés (sometimes).
 */
class ClientRequest extends FormRequest
{
    /** Une API répond toujours en JSON : pas de redirection HTML en cas de saisie invalide. */
    protected function failedValidation(Validator $validator): void
    {
        throw new HttpResponseException(response()->json([
            'error' => 'VALIDATION_FAILED',
            'message' => 'Données invalides.',
            'errors' => $validator->errors(),
        ], 422));
    }

    public function authorize(): bool
    {
        // L'autorisation réelle est appliquée par PostgreSQL (RLS, droit clients.write).
        return true;
    }

    /** @return array<string, array<int, mixed>> */
    public function rules(): array
    {
        $required = $this->isMethod('POST') ? 'required' : 'sometimes';

        return [
            'code' => ['nullable', 'string', 'regex:/^[A-Z0-9][A-Z0-9_-]{1,19}$/'],
            'name' => [$required, 'string', 'min:2', 'max:120'],
            'legal_name' => ['nullable', 'string', 'max:160'],
            'tax_id' => ['nullable', 'string', 'max:40'],
            'registration_no' => ['nullable', 'string', 'max:40'],
            'website' => ['nullable', 'string', 'max:200'],
            'email' => ['nullable', 'email', 'max:160'],
            'phone' => ['nullable', 'string', 'max:40'],
            'country' => [$required, 'string', Rule::in(config('clients.countries'))],
            'currency' => [$required, 'string', Rule::in(config('clients.currencies'))],
            'language' => [$required, 'string', Rule::in(config('clients.languages'))],
            'payment_method' => ['nullable', Rule::in(config('clients.payment_methods'))],
            'credit_limit' => ['nullable', 'numeric', 'min:0', 'max:1000000000'],
            'incoterm' => ['nullable', Rule::in(config('clients.incoterms'))],
            'vat_exempt' => ['sometimes', 'boolean'],
            'delivery_tolerance_pct' => ['sometimes', 'numeric', 'min:0', 'max:50'],
            'aql_level' => ['nullable', 'string', 'max:20'],
            'payment_terms_id' => ['nullable', 'uuid'],
            'sales_rep_id' => ['nullable', 'uuid'],
            'notes' => ['nullable', 'string', 'max:2000'],
        ];
    }

    /** Colonnes que l'API accepte en écriture (les mêmes que les droits d'insertion et de mise à jour de la base). */
    public static function writable(): array
    {
        return [
            'code', 'name', 'legal_name', 'tax_id', 'registration_no', 'website', 'email', 'phone', 'country', 'currency',
            'language', 'payment_method', 'credit_limit', 'incoterm', 'vat_exempt', 'delivery_tolerance_pct', 'aql_level',
            'payment_terms_id', 'sales_rep_id', 'notes',
        ];
    }
}
