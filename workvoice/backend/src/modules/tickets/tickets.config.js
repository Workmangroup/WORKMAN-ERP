import { CATEGORIES_RECLAMATION, THEMES_SUGGESTION, TYPES_DEMANDE } from '../../config/constants.js';

/**
 * Description des trois familles de tickets. Les noms de tables/colonnes
 * utilisés dans le SQL dynamique proviennent EXCLUSIVEMENT de cette constante,
 * jamais d'une entrée utilisateur.
 */
export const TICKET_KINDS = Object.freeze({
  demande: {
    kind: 'demande',
    table: 'demandes',
    numeroCol: 'numero_demande',
    typeCol: 'type_demande',
    types: TYPES_DEMANDE,
    prefixe: 'DEM',
    commentFk: 'demande_id',
    path: 'demandes',
    label: 'demande RH',
    labelCap: 'Demande RH',
  },
  reclamation: {
    kind: 'reclamation',
    table: 'reclamations',
    numeroCol: 'numero_reclamation',
    typeCol: 'categorie',
    types: CATEGORIES_RECLAMATION,
    prefixe: 'REC',
    commentFk: 'reclamation_id',
    path: 'reclamations',
    label: 'réclamation',
    labelCap: 'Réclamation',
  },
  suggestion: {
    kind: 'suggestion',
    table: 'suggestions',
    numeroCol: 'numero_suggestion',
    typeCol: 'theme',
    types: THEMES_SUGGESTION,
    prefixe: 'SUG',
    commentFk: 'suggestion_id',
    path: 'suggestions',
    label: 'suggestion',
    labelCap: 'Suggestion',
  },
});
