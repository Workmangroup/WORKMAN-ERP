<?php
declare(strict_types=1);

/**
 * Validation des formulaires. Accumule les erreurs puis lève une 422 au format
 * { champ, message } attendu par le frontend.
 */
final class Validator
{
    private array $errors = [];
    private array $out = [];

    public function __construct(private readonly array $in) {}

    private function fail(string $field, string $message): self
    {
        $this->errors[] = ['champ' => $field, 'message' => $message];
        return $this;
    }

    private function raw(string $field): mixed
    {
        return $this->in[$field] ?? null;
    }

    /** Texte obligatoire (ou facultatif si $min = 0), coupé des espaces. */
    public function text(string $field, int $min, int $max, string $label, bool $optional = false): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            if ($optional) {
                $this->out[$field] = null;
                return $this;
            }
            return $this->fail($field, "$label est obligatoire");
        }
        if (!is_string($v) && !is_numeric($v)) {
            return $this->fail($field, "$label est invalide");
        }
        $v = trim((string) $v);
        $len = mb_strlen($v);
        if ($len < $min) {
            return $this->fail($field, "$label doit contenir au moins $min caractères");
        }
        if ($len > $max) {
            return $this->fail($field, "$label ne peut pas dépasser $max caractères");
        }
        $this->out[$field] = $optional && $v === '' ? null : $v;
        return $this;
    }

    /** Valeur parmi une liste fermée. */
    public function enum(string $field, array $allowed, string $message, ?string $default = null): self
    {
        $v = $this->raw($field);
        if (($v === null || $v === '') && $default !== null) {
            $this->out[$field] = $default;
            return $this;
        }
        if (!is_string($v) || !in_array($v, $allowed, true)) {
            return $this->fail($field, $message);
        }
        $this->out[$field] = $v;
        return $this;
    }

    /** Booléen JSON ou formulaire (« true », « 1 », « on »). */
    public function bool(string $field, bool $default = false): self
    {
        $v = $this->raw($field);
        $this->out[$field] = $v === null ? $default : in_array($v, [true, 1, '1', 'true', 'on'], true);
        return $this;
    }

    /** Date AAAA-MM-JJ. */
    public function date(string $field, string $label, bool $optional = false): self
    {
        $v = $this->raw($field);
        if ($v === null || $v === '') {
            if ($optional) {
                $this->out[$field] = null;
                return $this;
            }
            return $this->fail($field, "$label est obligatoire");
        }
        $d = is_string($v) ? DateTime::createFromFormat('!Y-m-d', $v) : false;
        if (!$d || $d->format('Y-m-d') !== $v) {
            return $this->fail($field, "$label invalide");
        }
        $this->out[$field] = $v;
        return $this;
    }

    public function check(bool $condition, string $field, string $message): self
    {
        return $condition ? $this : $this->fail($field, $message);
    }

    public function get(string $field): mixed
    {
        return $this->out[$field] ?? null;
    }

    /** Renvoie les valeurs validées ou lève une 422. */
    public function done(): array
    {
        if ($this->errors) {
            throw new HttpError(422, 'Certains champs sont invalides', 'VALIDATION_ERROR', $this->errors);
        }
        return $this->out;
    }
}

function validator(?array $in = null): Validator
{
    return new Validator($in ?? body());
}
