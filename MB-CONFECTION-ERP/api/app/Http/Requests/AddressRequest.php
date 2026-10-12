<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

/** Adresse d'un client : mêmes règles que addressSchema (web). */
class AddressRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // droits appliqués par la base (clients.write)
    }

    protected function failedValidation(Validator $validator): void
    {
        throw new HttpResponseException(response()->json([
            'error' => 'VALIDATION_FAILED', 'message' => 'Données invalides.', 'errors' => $validator->errors(),
        ], 422));
    }

    /** @return array<string, array<int, mixed>> */
    public function rules(): array
    {
        $required = $this->isMethod('POST') ? 'required' : 'sometimes';

        return [
            'type' => [$required, Rule::in(['head_office', 'billing', 'delivery', 'other'])],
            'label' => ['nullable', 'string', 'max:60'],
            'line1' => [$required, 'string', 'min:2', 'max:160'],
            'line2' => ['nullable', 'string', 'max:160'],
            'postal_code' => ['nullable', 'string', 'max:20'],
            'city' => [$required, 'string', 'min:1', 'max:80'],
            'region' => ['nullable', 'string', 'max:80'],
            'country' => [$required, 'string', Rule::in(config('clients.countries'))],
            'is_default' => ['sometimes', 'boolean'],
            'notes' => ['nullable', 'string', 'max:1000'],
        ];
    }

    /** @return array<string, mixed> */
    public function payload(): array
    {
        $allowed = ['type', 'label', 'line1', 'line2', 'postal_code', 'city', 'region', 'country', 'is_default', 'notes'];

        return collect($this->validated())->only($allowed)
            ->map(fn ($v) => $v === '' ? null : $v)->all();
    }
}
