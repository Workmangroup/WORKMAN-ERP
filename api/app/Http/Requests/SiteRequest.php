<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;

/** Site de la société : mêmes contraintes que la table sites (migration 0032). La société vient du jeton, jamais du corps. */
class SiteRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true; // droits appliqués par la base (sites.manage)
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
            'code' => [$required, 'string', 'regex:/^[A-Z0-9][A-Z0-9._-]{0,19}$/'],
            'name' => [$required, 'string', 'min:2', 'max:120'],
            'city' => ['nullable', 'string', 'max:80'],
            'address' => ['nullable', 'string', 'max:200'],
        ];
    }

    /** @return array<string, mixed> */
    public function payload(): array
    {
        $allowed = ['code', 'name', 'city', 'address'];

        return collect($this->validated())->only($allowed)
            ->map(fn ($v) => $v === '' ? null : $v)->all();
    }
}
