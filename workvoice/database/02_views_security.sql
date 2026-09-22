-- =====================================================================
--  WORKVOICE — 02_views_security.sql
--  Vues anonymisées pour la Direction + comptes MySQL à moindre privilège
-- =====================================================================

USE workvoice;

-- ---------------------------------------------------------------------
--  Vue Direction — réclamations
--  AUCUNE colonne d'identité (nom, prénom, e-mail, téléphone, matricule,
--  user_id). Le service est masqué pour les réclamations confidentielles.
-- ---------------------------------------------------------------------
CREATE OR REPLACE
  SQL SECURITY DEFINER
VIEW v_direction_reclamations AS
SELECT
  r.id,
  r.numero_reclamation,
  r.categorie,
  r.objet,
  r.description,
  r.niveau_urgence,
  r.confidentielle,
  r.statut,
  r.date_creation,
  r.date_cloture,
  CASE WHEN r.confidentielle = 1 THEN NULL ELSE u.service END AS service,
  u.departement,
  u.site
FROM reclamations r
JOIN users u ON u.id = r.user_id;

-- ---------------------------------------------------------------------
--  Vue Direction — demandes (statistiques uniquement : pas d'objet ni
--  de description, qui contiennent souvent des informations personnelles)
-- ---------------------------------------------------------------------
CREATE OR REPLACE
  SQL SECURITY DEFINER
VIEW v_direction_demandes AS
SELECT
  d.id,
  d.type_demande,
  d.statut,
  d.date_creation,
  d.date_cloture,
  u.service,
  u.departement,
  u.site
FROM demandes d
JOIN users u ON u.id = d.user_id;

-- ---------------------------------------------------------------------
--  Comptes MySQL (production) — à exécuter par un administrateur.
--  Remplacer les mots de passe avant exécution.
--
--  workvoice_app       : compte principal de l'API
--  workvoice_direction : utilisé par le module Direction de l'API
--                        (DB_DIRECTION_USER). Il ne peut lire QUE les vues :
--                        même en cas de faille applicative, les identités
--                        restent inaccessibles depuis ce compte.
-- ---------------------------------------------------------------------
-- CREATE USER IF NOT EXISTS 'workvoice_app'@'%'       IDENTIFIED BY 'ChangeMe-App-!2026';
-- CREATE USER IF NOT EXISTS 'workvoice_direction'@'%' IDENTIFIED BY 'ChangeMe-Dir-!2026';
--
-- GRANT SELECT, INSERT, UPDATE, DELETE ON workvoice.* TO 'workvoice_app'@'%';
--
-- GRANT SELECT ON workvoice.v_direction_reclamations TO 'workvoice_direction'@'%';
-- GRANT SELECT ON workvoice.v_direction_demandes     TO 'workvoice_direction'@'%';
--
-- FLUSH PRIVILEGES;
