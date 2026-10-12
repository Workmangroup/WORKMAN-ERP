<?php

namespace App\Http\Requests;

use Illuminate\Contracts\Validation\Validator;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Validation\Rule;

/** Contact d'un client : mêmes règles que contactSchema (web). */
class ContactRequest extends FormRequest
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
            'full_name' => [$required, 'string', 'min:2', 'max:100'],
            'job_title' => ['nullable', 'string', 'max:100'],
            'email' => ['nullable', 'email', 'max:160'],
            'phone' => ['nullable', 'string', 'max:40'],
            'mobile' => ['nullable', 'string', 'max:40'],
            'language' => ['nullable', Rule::in(config('clients.languages'))],
            'is_primary' => ['sometimes', 'boolean'],
            'notes' => ['nullable', 'string', 'max:1000'],
        ];
    }

    /** @return array<string, mixed> */
    public function payload(): array
    {
        $allowed = ['full_name', 'job_title', 'email', 'phone', 'mobile', 'language', 'is_primary', 'notes'];

        return collect($this->validated())->only($allowed)
            ->map(fn ($v) => $v === '' ? null : $v)->all();
    }
}
