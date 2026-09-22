<?php
// WORKVOICE — point d'entrée de l'API. Syntaxe volontairement simple ici pour
// afficher un message clair si l'hébergement utilise une version de PHP trop ancienne.
if (PHP_VERSION_ID < 80100) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(array('error' => array(
        'code' => 'PHP_VERSION',
        'message' => 'WORKVOICE nécessite PHP 8.1 ou plus (version actuelle : ' . PHP_VERSION . '). Vérifiez le fichier .ovhconfig à la racine du site.',
    )));
    exit;
}
require __DIR__ . '/lib/bootstrap.php';
