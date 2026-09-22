<?php
/*
 * =====================================================================
 *  WORKVOICE — Configuration de l'API (hébergement OVH)
 *
 *  MODÈLE : copier ce fichier en config.php, puis renseigner 'db_password'
 *  et 'jwt_secret' (ex. : php -r "echo bin2hex(random_bytes(32));").
 *  Ces informations se trouvent dans l'espace client OVH :
 *    Hébergements > votre hébergement > onglet « Bases de données »
 *
 *  Ce fichier n'est pas accessible depuis le web (bloqué par .htaccess).
 * =====================================================================
 */
return [
    // --- Base de données MySQL (OVH) ------------------------------------
    // « Adresse du serveur » affichée par OVH, en général : nomdelabase.mysql.db
    'db_host'     => 'workmagrh.mysql.db',
    'db_port'     => 3306,
    'db_name'     => 'workmagrh',
    // Chez OVH, l'utilisateur porte en général le même nom que la base
    'db_user'     => 'workmagrh',
    'db_password' => 'METTRE_ICI_LE_MOT_DE_PASSE_DE_LA_BASE',

    // Optionnel : compte MySQL limité aux vues anonymisées pour l'espace Direction.
    // Laisser vide sur un hébergement mutualisé.
    'db_direction_user'     => '',
    'db_direction_password' => '',

    // --- Sécurité --------------------------------------------------------
    // Clé secrète de signature des sessions : 32 caractères aléatoires minimum.
    // La changer déconnecte tous les utilisateurs, sans autre conséquence.
    'jwt_secret' => 'GENERER_UNE_CLE_ALEATOIRE_DE_64_CARACTERES',
    'jwt_ttl'    => 8 * 3600, // durée d'une session : 8 heures

    // Fuseau horaire des dates enregistrées (Tunisie : UTC+1)
    'timezone' => '+01:00',

    // --- Site -----------------------------------------------------------
    // Adresse publique du site (utilisée dans les liens des e-mails)
    'site_url' => 'https://rh.workman-stid.com',

    // Pièces jointes des demandes RH
    'upload_max_mb' => 5,

    // --- E-mails de notification ------------------------------------------
    // Envoyés avec la fonction mail() de l'hébergement OVH (aucun réglage SMTP).
    'mail_enabled' => true,
    'mail_from'    => 'WORKVOICE <noreply@workman-stid.com>',

    // true uniquement pour diagnostiquer une erreur (affiche le détail technique)
    'debug' => false,
];
