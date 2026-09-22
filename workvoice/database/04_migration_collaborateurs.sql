-- =====================================================================
--  WORKVOICE — Migration « gestion des collaborateurs par le RH »
--  À exécuter une fois sur une base installée avant cette version.
--  (L'API PHP l'applique aussi automatiquement si nécessaire.)
-- =====================================================================
ALTER TABLE users
  ADD COLUMN mdp_temporaire TINYINT(1) NOT NULL DEFAULT 0
  COMMENT '1 = mot de passe provisoire à changer à la prochaine connexion'
  AFTER password;
