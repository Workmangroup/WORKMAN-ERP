<?php
// Tests hors WordPress : fonctions WordPress simulées, logique du plugin réelle.
// Lancement : php tests/run.php
define('ABSPATH', __DIR__);
$GLOBALS['opts'] = [];
$GLOBALS['enq'] = [];
$GLOBALS['inline'] = [];
$GLOBALS['admin'] = false;

function add_action() {}
function add_options_page() {}
function register_setting() {}
function get_option($k, $d = false) { return $GLOBALS['opts'][$k] ?? $d; }
function is_admin() { return $GLOBALS['admin']; }
function plugins_url($p) { return 'https://example.test/wp-content/plugins/workman-assistant/'.$p; }
function wp_enqueue_script(...$a) { $GLOBALS['enq'][] = $a; }
function wp_print_inline_script_tag($js, $attr = []) { $GLOBALS['inline'][] = $js; }
function wp_json_encode($v) { return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); }

require dirname(__DIR__).'/workman-assistant.php';

$results = [];
$ok = function (string $name, bool $cond) use (&$results) {
    $results[] = $cond;
    echo ($cond ? 'PASS' : 'FAIL').'  '.$name.PHP_EOL;
};

// 1. Défauts et nettoyage
$ok('défaut : désactivé, français, sans lien', workman_assistant_defaults() === ['enabled' => false, 'lang' => 'fr', 'contact_url' => '']);
$ok('entrée absente : désactivé', workman_assistant_sanitize(null)['enabled'] === false);
$ok('langue inconnue ramenée à fr', workman_assistant_sanitize(['lang' => 'de'])['lang'] === 'fr');
$ok('arabe accepté', workman_assistant_sanitize(['lang' => 'ar'])['lang'] === 'ar');
$ok('lien http(s) accepté', workman_assistant_sanitize(['contact_url' => 'https://www.workman-stid.com/contact'])['contact_url'] === 'https://www.workman-stid.com/contact');
$ok('lien javascript: refusé', workman_assistant_sanitize(['contact_url' => 'javascript:alert(1)'])['contact_url'] === '');
$ok('lien relatif refusé', workman_assistant_sanitize(['contact_url' => '/contact'])['contact_url'] === '');
$ok('case cochée = activé', workman_assistant_sanitize(['enabled' => '1'])['enabled'] === true);

// 2. Désactivé par défaut : aucun script, aucune configuration
$GLOBALS['opts'] = [];
workman_assistant_enqueue();
workman_assistant_inline_config();
$ok('sans réglage : aucun script chargé', count($GLOBALS['enq']) === 0);
$ok('sans réglage : aucune configuration injectée', count($GLOBALS['inline']) === 0);

// 3. Activé : script en différé dans le pied de page, configuration JSON
$GLOBALS['opts'] = [WORKMAN_ASSISTANT_OPTION => ['enabled' => true, 'lang' => 'ar', 'contact_url' => '']];
workman_assistant_enqueue();
workman_assistant_inline_config();
$ok('activé : script chargé une fois', count($GLOBALS['enq']) === 1);
$ok('activé : stratégie defer et pied de page', ($GLOBALS['enq'][0][4]['strategy'] ?? '') === 'defer' && ($GLOBALS['enq'][0][4]['in_footer'] ?? false) === true);
$ok('activé : URL du script dans le plugin', str_ends_with($GLOBALS['enq'][0][1], '/assets/workman-assistant.js'));
$ok('configuration : langue ar, contactUrl null', $GLOBALS['inline'][0] === 'window.WorkmanAssistant = {"enabled":true,"lang":"ar","contactUrl":null};');

// 4. Pas de chargement dans l'administration, même activé
$GLOBALS['admin'] = true;
$GLOBALS['enq'] = [];
workman_assistant_enqueue();
$ok('administration : aucun script', count($GLOBALS['enq']) === 0);
$GLOBALS['admin'] = false;

// 5. Lien de contact injecté tel quel
$GLOBALS['opts'] = [WORKMAN_ASSISTANT_OPTION => ['enabled' => true, 'lang' => 'fr', 'contact_url' => 'https://www.workman-stid.com/contact']];
$GLOBALS['inline'] = [];
workman_assistant_inline_config();
$ok('configuration : contactUrl renseigné', str_contains($GLOBALS['inline'][0], '"contactUrl":"https://www.workman-stid.com/contact"'));

$all = !in_array(false, $results, true);
echo PHP_EOL.($all ? 'OK' : 'ÉCHEC').' ('.count(array_filter($results)).'/'.count($results).')'.PHP_EOL;
exit($all ? 0 : 1);
