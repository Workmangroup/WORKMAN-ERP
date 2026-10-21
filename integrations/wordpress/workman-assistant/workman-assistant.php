<?php
/**
 * Plugin Name: Assistant Workman
 * Description: Affiche la bulle « Assistant Workman » en bas de page. Inactive tant que l'option n'est pas activée.
 * Version: 0.1.0
 * Requires at least: 6.3
 * Requires PHP: 8.1
 * Author: Workman Group
 * License: Proprietary
 * Text Domain: workman-assistant
 */

if (! defined('ABSPATH')) {
    exit;
}

const WORKMAN_ASSISTANT_OPTION = 'workman_assistant_settings';
const WORKMAN_ASSISTANT_VERSION = '0.1.0';

/**
 * Réglages par défaut : désactivé, français, aucun lien de contact.
 *
 * @return array{enabled: bool, lang: string, contact_url: string}
 */
function workman_assistant_defaults(): array
{
    return ['enabled' => false, 'lang' => 'fr', 'contact_url' => ''];
}

/**
 * Nettoie les réglages saisis. Toute valeur inconnue revient au défaut.
 *
 * @param  mixed  $input
 * @return array{enabled: bool, lang: string, contact_url: string}
 */
function workman_assistant_sanitize($input): array
{
    $input = is_array($input) ? $input : [];
    $lang = $input['lang'] ?? 'fr';
    $contact = trim((string) ($input['contact_url'] ?? ''));

    return [
        'enabled' => ! empty($input['enabled']),
        'lang' => in_array($lang, ['fr', 'en', 'ar'], true) ? $lang : 'fr',
        'contact_url' => $contact !== '' && filter_var($contact, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $contact)
            ? $contact
            : '',
    ];
}

/**
 * Réglages effectifs (valeurs enregistrées, complétées par les défauts).
 *
 * @return array{enabled: bool, lang: string, contact_url: string}
 */
function workman_assistant_settings(): array
{
    $saved = get_option(WORKMAN_ASSISTANT_OPTION, []);

    return workman_assistant_sanitize(array_merge(workman_assistant_defaults(), is_array($saved) ? $saved : []));
}

/** Chemin du script bundlé, dans le dossier du plugin. */
function workman_assistant_script_url(): string
{
    return plugins_url('assets/workman-assistant.js', __FILE__);
}

/**
 * Charge le script uniquement côté public, uniquement si la bulle est activée.
 * Le script est chargé en différé, dans le pied de page.
 */
function workman_assistant_enqueue(): void
{
    if (is_admin() || ! workman_assistant_settings()['enabled']) {
        return;
    }
    wp_enqueue_script('workman-assistant', workman_assistant_script_url(), [], WORKMAN_ASSISTANT_VERSION, ['in_footer' => true, 'strategy' => 'defer']);
}

/**
 * Configuration lue par le script (même format que la notice d'intégration).
 */
function workman_assistant_inline_config(): void
{
    if (is_admin() || ! workman_assistant_settings()['enabled']) {
        return;
    }
    $s = workman_assistant_settings();
    $config = [
        'enabled' => true,
        'lang' => $s['lang'],
        'contactUrl' => $s['contact_url'] !== '' ? $s['contact_url'] : null,
    ];
    wp_print_inline_script_tag('window.WorkmanAssistant = '.wp_json_encode($config).';', ['id' => 'workman-assistant-config']);
}

/* ------------------------------------------------------------------ */
/* Page de réglages : Réglages > Assistant Workman                    */
/* ------------------------------------------------------------------ */

function workman_assistant_menu(): void
{
    add_options_page('Assistant Workman', 'Assistant Workman', 'manage_options', 'workman-assistant', 'workman_assistant_render_page');
}

function workman_assistant_register_settings(): void
{
    register_setting('workman_assistant', WORKMAN_ASSISTANT_OPTION, [
        'type' => 'array',
        'sanitize_callback' => 'workman_assistant_sanitize',
        'default' => workman_assistant_defaults(),
    ]);
}

function workman_assistant_render_page(): void
{
    if (! current_user_can('manage_options')) {
        return;
    }
    $s = workman_assistant_settings();
    $name = WORKMAN_ASSISTANT_OPTION;
    ?>
    <div class="wrap">
      <h1>Assistant Workman</h1>
      <p>La bulle reste masquée tant que l'option « Activer » n'est pas cochée. Ne l'activez qu'après validation de la conversation et des transferts de données.</p>
      <form method="post" action="options.php">
        <?php settings_fields('workman_assistant'); ?>
        <table class="form-table" role="presentation">
          <tr>
            <th scope="row">Activer la bulle</th>
            <td><label><input type="checkbox" name="<?php echo esc_attr($name); ?>[enabled]" value="1" <?php checked($s['enabled']); ?>> Afficher la bulle sur le site public</label></td>
          </tr>
          <tr>
            <th scope="row"><label for="workman-assistant-lang">Langue</label></th>
            <td>
              <select id="workman-assistant-lang" name="<?php echo esc_attr($name); ?>[lang]">
                <option value="fr" <?php selected($s['lang'], 'fr'); ?>>Français</option>
                <option value="en" <?php selected($s['lang'], 'en'); ?>>English</option>
                <option value="ar" <?php selected($s['lang'], 'ar'); ?>>العربية</option>
              </select>
            </td>
          </tr>
          <tr>
            <th scope="row"><label for="workman-assistant-contact">Lien de contact</label></th>
            <td>
              <input id="workman-assistant-contact" type="url" class="regular-text" name="<?php echo esc_attr($name); ?>[contact_url]" value="<?php echo esc_attr($s['contact_url']); ?>" placeholder="https://www.workman-stid.com/contact">
              <p class="description">Facultatif. Adresse absolue en http ou https.</p>
            </td>
          </tr>
        </table>
        <?php submit_button(); ?>
      </form>
    </div>
    <?php
}

add_action('wp_enqueue_scripts', 'workman_assistant_enqueue');
add_action('wp_footer', 'workman_assistant_inline_config', 5);
add_action('admin_menu', 'workman_assistant_menu');
add_action('admin_init', 'workman_assistant_register_settings');
