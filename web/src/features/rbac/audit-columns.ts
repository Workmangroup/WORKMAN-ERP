/** Colonnes de audit_logs lisibles en direct (sans IP ni navigateur : réservés à l'export auditeur, audit.export). */
export const AUDIT_READ_COLUMNS = 'id, company_id, actor_id, actor_email, action, entity_type, entity_id, entity_label, before_data, after_data, metadata, source, created_at, correlation_id, actor_kind, delegation_id, on_behalf_of, entity_version, significant, reason, scope'
