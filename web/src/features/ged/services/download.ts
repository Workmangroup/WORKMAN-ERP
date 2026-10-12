import 'server-only'
import { NextResponse } from 'next/server'
import { isInlineMime, kindOfMime } from '@/lib/ged/constants'

/** Version autorisée à être servie, telle que renvoyée par ged_download_check ou ged_link_resolve (aucune donnée supplémentaire). */
export interface ServableVersion {
  storage_bucket: string
  storage_path: string
  file_name: string
  mime_type: string
  version_no: number
}

const DENIED: Record<string, { status: number; error: string; message: string }> = {
  GED_NOT_PUBLISHED: { status: 423, error: 'NOT_PUBLISHED', message: 'Ce fichier est en cours d’analyse ou en quarantaine : il ne peut pas être téléchargé.' },
  GED_NOT_FOUND: { status: 404, error: 'NOT_FOUND', message: 'Fichier introuvable.' },
  GED_LINK_INVALID: { status: 404, error: 'LINK_INVALID', message: 'Ce lien n’existe pas.' },
  GED_LINK_EXPIRED: { status: 410, error: 'LINK_EXPIRED', message: 'Ce lien a expiré.' },
  GED_LINK_REVOKED: { status: 410, error: 'LINK_REVOKED', message: 'Ce lien a été révoqué.' },
  RBAC_FORBIDDEN: { status: 403, error: 'FORBIDDEN', message: 'Vous n’avez pas accès à ce fichier.' },
  CLIENT_ARCHIVED: { status: 403, error: 'FORBIDDEN', message: 'La fiche client est archivée : ses fichiers ne sont pas accessibles.' },
}

/** Réponse de refus : code HTTP et message compréhensible, sans détail technique de la base. */
export function downloadDenied(err: { message?: string; details?: string | null } | null | undefined): NextResponse {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  const key = Object.keys(DENIED).find((k) => text.includes(k))
  const d = key ? DENIED[key] : { status: 502, error: 'FILE_UNAVAILABLE', message: 'Le fichier est momentanément indisponible.' }
  return NextResponse.json({ error: d.error, message: d.message }, { status: d.status, headers: { 'cache-control': 'no-store' } })
}

/**
 * Sert le fichier : aperçu intégré pour les types sûrs, sinon téléchargement. Pas de lien public, en-têtes de sécurité maîtrisés
 * (le fichier n'a jamais de contenu actif dans notre origine).
 */
export function fileResponse(blob: Blob, v: ServableVersion, wantsInline: boolean): NextResponse {
  const inline = wantsInline && isInlineMime(v.mime_type)
  const kind = kindOfMime(v.mime_type)
  const headers = new Headers({
    'Content-Type': inline ? v.mime_type : 'application/octet-stream',
    'Content-Length': String(blob.size),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.file_name)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
  })
  headers.set('Content-Security-Policy', kind === 'pdf'
    ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; sandbox")
  return new NextResponse(blob.stream(), { headers })
}
