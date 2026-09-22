import { z } from 'zod';
import {
  CATEGORIES_RECLAMATION,
  CATEGORIES_TOUJOURS_CONFIDENTIELLES,
  NIVEAUX_URGENCE,
  STATUTS,
  THEMES_SUGGESTION,
  TYPES_DEMANDE,
} from '../../config/constants.js';
import { paginationSchema } from '../../utils/pagination.js';

/** Booléen accepté en JSON ou en multipart (« true », « 1 », « on »). */
export const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'on', 'off'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'on');

const objet = z
  .string({ error: "L'objet est obligatoire" })
  .trim()
  .min(3, "L'objet doit contenir au moins 3 caractères")
  .max(150, "L'objet ne peut pas dépasser 150 caractères");

const description = (min) =>
  z
    .string({ error: 'La description est obligatoire' })
    .trim()
    .min(min, `La description doit contenir au moins ${min} caractères`)
    .max(5000, 'La description ne peut pas dépasser 5000 caractères');

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const demandeCreateSchema = z.object({
  type_demande: z.enum(TYPES_DEMANDE, { error: 'Type de demande invalide' }),
  objet,
  description: description(10),
});

export const reclamationCreateSchema = z
  .object({
    categorie: z.enum(CATEGORIES_RECLAMATION, { error: 'Catégorie invalide' }),
    objet,
    description: description(20),
    niveau_urgence: z.enum(NIVEAUX_URGENCE, { error: "Niveau d'urgence invalide" }).default('MOYEN'),
    confidentielle: boolish.default(false),
  })
  .transform((r) => ({
    ...r,
    // Le harcèlement est toujours confidentiel, quelle que soit la case cochée
    confidentielle: r.confidentielle || CATEGORIES_TOUJOURS_CONFIDENTIELLES.includes(r.categorie) ? 1 : 0,
  }));

export const suggestionCreateSchema = z.object({
  theme: z.enum(THEMES_SUGGESTION, { error: 'Thème invalide' }).default('AUTRE'),
  objet,
  description: description(10),
});

export const commentSchema = z.object({
  message: z
    .string({ error: 'Le message est obligatoire' })
    .trim()
    .min(1, 'Le message est obligatoire')
    .max(3000, 'Le message ne peut pas dépasser 3000 caractères'),
});

export const statusSchema = z.object({
  statut: z.enum(STATUTS, { error: 'Statut invalide' }),
  commentaire: z.string().trim().max(3000).optional(),
});

/** Filtres de liste RH, adaptés à la famille de ticket. */
export function makeListSchema(cfg) {
  return z.object({
    statut: z.enum(STATUTS).optional(),
    type: z.enum(cfg.types).optional(),
    urgence: z.enum(NIVEAUX_URGENCE).optional(),
    ouverts: boolish.optional(),
    site: z.string().trim().max(80).optional(),
    departement: z.string().trim().max(80).optional(),
    q: z.string().trim().max(100).optional(),
    ...paginationSchema,
  });
}
