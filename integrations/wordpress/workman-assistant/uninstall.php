<?php
// Suppression du plugin : retire le réglage enregistré. Aucune autre donnée n'est créée.
if (! defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

delete_option('workman_assistant_settings');
