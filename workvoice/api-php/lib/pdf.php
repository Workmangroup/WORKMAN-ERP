<?php
declare(strict_types=1);

/*
 * Générateur PDF minimal, sans dépendance externe (aucun Composer requis,
 * déployable par simple copie FTP). Écrit directement les objets PDF 1.4.
 * Police standard Helvetica (WinAnsiEncoding) : pas d'embarquement de
 * police nécessaire. Pas d'image/logo dans cette version — limitation
 * connue, documentée dans ARCHITECTURE_ATTESTATIONS_COFFRE_FORT.md.
 */

final class PdfWriter
{
    private const PAGE_W = 595.28;
    private const PAGE_H = 841.89;

    /** @var array<int, array{0: float, 1: float, 2: float, 3: bool, 4: string}> */
    private array $lines = [];
    /** @var array<int, array{0: float, 1: float, 2: float, 3: float}> */
    private array $rects = [];

    public function text(float $x, float $y, string $text, float $size = 11, bool $bold = false): void
    {
        $this->lines[] = [$x, $y, $size, $bold, $text];
    }

    /** Découpe un paragraphe sur plusieurs lignes de largeur $maxWidth ; renvoie le y après le texte. */
    public function paragraph(float $x, float $y, string $text, float $maxWidth, float $size = 11, float $leading = 15): float
    {
        foreach (preg_split('/\r?\n/', trim($text)) as $srcLine) {
            if ($srcLine === '') {
                $y -= $leading;
                continue;
            }
            $line = '';
            foreach (preg_split('/\s+/', $srcLine) as $w) {
                $test = $line === '' ? $w : "$line $w";
                if ($this->textWidth($test, $size) > $maxWidth && $line !== '') {
                    $this->text($x, $y, $line, $size);
                    $y -= $leading;
                    $line = $w;
                } else {
                    $line = $test;
                }
            }
            if ($line !== '') {
                $this->text($x, $y, $line, $size);
                $y -= $leading;
            }
        }
        return $y;
    }

    public function filledRect(float $x, float $y, float $w, float $h): void
    {
        $this->rects[] = [$x, $y, $w, $h];
    }

    public static function pageWidth(): float
    {
        return self::PAGE_W;
    }

    public static function pageHeight(): float
    {
        return self::PAGE_H;
    }

    /** Largeur approximative d'un texte en Helvetica (table AFM simplifiée, /1000 em). */
    private function textWidth(string $text, float $size): float
    {
        static $widths = null;
        if ($widths === null) {
            $widths = array_fill(32, 95, 556);
            foreach (['i' => 222, 'l' => 222, 'j' => 222, 'I' => 278, '.' => 278, ',' => 278, "'" => 191, ' ' => 278, 'f' => 333, 't' => 278, 'r' => 333] as $ch => $w) {
                $widths[ord($ch)] = $w;
            }
        }
        $w = 0;
        foreach (str_split($text) as $ch) {
            $w += $widths[ord($ch)] ?? 556;
        }
        return $w * $size / 1000;
    }

    private function encode(string $text): string
    {
        $converted = @iconv('UTF-8', 'Windows-1252//TRANSLIT//IGNORE', $text);
        $text = $converted !== false ? $converted : $text;
        return str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $text);
    }

    public function output(): string
    {
        $content = "q\n";
        foreach ($this->rects as [$x, $y, $w, $h]) {
            $content .= sprintf("0.043 0.239 0.569 rg\n%.2f %.2f %.2f %.2f re f\n", $x, $y, $w, $h);
        }
        $content .= "Q\nBT\n";
        foreach ($this->lines as [$x, $y, $size, $bold, $text]) {
            $font = $bold ? '/F2' : '/F1';
            $content .= sprintf("%s %.1f Tf\n0 0 0 rg\n1 0 0 1 %.2f %.2f Tm\n(%s) Tj\n", $font, $size, $x, $y, $this->encode($text));
        }
        $content .= 'ET';

        $objects = [];
        $objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
        $objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
        $objects[3] = sprintf(
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.2f %.2f] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
            self::PAGE_W,
            self::PAGE_H,
        );
        $objects[4] = sprintf("<< /Length %d >>\nstream\n%s\nendstream", strlen($content), $content);
        $objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
        $objects[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

        $pdf = "%PDF-1.4\n";
        $offsets = [];
        foreach ($objects as $num => $body) {
            $offsets[$num] = strlen($pdf);
            $pdf .= "$num 0 obj\n$body\nendobj\n";
        }
        $xrefStart = strlen($pdf);
        $count = count($objects);
        $pdf .= "xref\n0 " . ($count + 1) . "\n0000000000 65535 f \n";
        for ($i = 1; $i <= $count; $i++) {
            $pdf .= sprintf("%010d 00000 n \n", $offsets[$i]);
        }
        $pdf .= "trailer\n<< /Size " . ($count + 1) . " /Root 1 0 R >>\nstartxref\n$xrefStart\n%%EOF";
        return $pdf;
    }
}

/**
 * Génère le PDF d'une attestation à partir des données déjà validées et
 * figées (snapshot) : jamais depuis des données recalculées à la volée,
 * conformément à la règle « le document généré utilise les données
 * validées, jamais le frontend comme source de vérité ».
 */
function generate_attestation_pdf(array $company, array $attestation): string
{
    $pdf = new PdfWriter();
    $margin = 56.7; // 2 cm
    $width = PdfWriter::pageWidth();
    $y = PdfWriter::pageHeight() - 56.7;

    $pdf->filledRect(0, $y - 6, $width, 4);
    $pdf->text($margin, $y + 24, (string) $company['company_name'], 16, true);
    if (!empty($company['legal_name'])) {
        $pdf->text($margin, $y + 6, (string) $company['legal_name'], 9);
    }
    $adresse = trim(($company['address'] ?? '') . ($company['city'] ? ' — ' . $company['city'] : ''));
    if ($adresse !== '') {
        $pdf->text($margin, $y - 8, $adresse, 9);
    }
    $y -= 60;

    $titre = $attestation['type'] === 'ATTESTATION_SALAIRE' ? 'ATTESTATION DE SALAIRE' : 'ATTESTATION DE TRAVAIL';
    $pdf->text($width / 2 - 90, $y, $titre, 14, true);
    $y -= 40;

    $dateEmbauche = $attestation['snapshot_date_embauche'] ? date('d/m/Y', strtotime($attestation['snapshot_date_embauche'])) : null;
    $corps = $attestation['type'] === 'ATTESTATION_SALAIRE'
        ? sprintf(
            "Nous soussignés, %s, attestons que %s %s, matricule %s, occupe au sein de notre société le poste de %s%s.\n\n" .
            "Les éléments détaillés de rémunération peuvent être communiqués séparément par le service Paie sur demande motivée.\n\n" .
            "La présente attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.",
            $company['company_name'], $attestation['snapshot_prenom'], $attestation['snapshot_nom'], $attestation['snapshot_matricule'],
            $attestation['snapshot_fonction'] ?: 'non renseigné', $dateEmbauche ? " depuis le $dateEmbauche" : '',
        )
        : sprintf(
            "Nous soussignés, %s, attestons que %s %s, matricule %s, est employé(e) au sein de notre société en qualité de %s%s.\n\n" .
            "La présente attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.",
            $company['company_name'], $attestation['snapshot_prenom'], $attestation['snapshot_nom'], $attestation['snapshot_matricule'],
            $attestation['snapshot_fonction'] ?: 'non renseigné', $dateEmbauche ? " depuis le $dateEmbauche" : '',
        );
    $y = $pdf->paragraph($margin, $y, $corps, $width - 2 * $margin, 11, 16);
    $y -= 30;

    $pdf->text($margin, $y, 'Fait pour servir et valoir ce que de droit.', 10);
    $y -= 40;
    $pdf->text($width - $margin - 180, $y, 'Fait le ' . date('d/m/Y'), 10);
    $y -= 60;
    $pdf->text($width - $margin - 180, $y, 'Le Service des Ressources Humaines', 10);

    $pdf->text($margin, 40, 'Document N° ' . $attestation['numero'] . ' — Émis par WORKVOICE le ' . date('d/m/Y à H:i'), 7);

    return $pdf->output();
}
