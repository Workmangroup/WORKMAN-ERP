/*!
 * Assistant Workman — bulle d'accueil intégrable à un site tiers.
 * Script autonome, sans dépendance. Interface dans un Shadow DOM : les styles du site n'interfèrent pas.
 *
 * Inactif par défaut : tant que `enabled` n'est pas à true, rien n'est affiché ni chargé.
 * Aucun appel réseau dans cette version : la conversation n'est pas encore branchée (B1, ADR-002).
 *
 * Configuration (avant le chargement du script) :
 *   window.WorkmanAssistant = { enabled: true, lang: 'fr', contactUrl: 'https://…' };
 * ou attributs data- sur la balise <script> : data-enabled="true" data-lang="ar" data-contact-url="…".
 */
(function () {
  'use strict';

  var TEXTS = {
    fr: {
      open: 'Assistant Workman',
      title: 'Assistant Workman',
      body: 'L’assistant est en cours de mise en service. Pour toute demande, utilisez le lien ci-dessous ou les coordonnées du site.',
      contact: 'Nous contacter',
      close: 'Fermer l’assistant',
      dir: 'ltr'
    },
    en: {
      open: 'Workman Assistant',
      title: 'Workman Assistant',
      body: 'The assistant is being set up. For any request, use the link below or the contact details on this site.',
      contact: 'Contact us',
      close: 'Close the assistant',
      dir: 'ltr'
    },
    ar: {
      open: 'مساعد Workman',
      title: 'مساعد Workman',
      body: 'المساعد قيد التشغيل. لأي طلب، استعملوا الرابط أدناه أو بيانات الاتصال في الموقع.',
      contact: 'تواصلوا معنا',
      close: 'إغلاق المساعد',
      dir: 'rtl'
    }
  };

  function readConfig() {
    var script = document.currentScript || document.querySelector('script[src*="workman-assistant"]');
    var conf = window.WorkmanAssistant || {};
    var ds = (script && script.dataset) || {};
    var lang = conf.lang || ds.lang || 'fr';
    return {
      enabled: conf.enabled === true || ds.enabled === 'true',
      lang: TEXTS[lang] ? lang : 'fr',
      contactUrl: conf.contactUrl || ds.contactUrl || null
    };
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text) node.textContent = text;
    return node;
  }

  var STYLE = [
    ':host { all: initial; }',
    '.wm-root { position: fixed; bottom: 16px; inset-inline-end: 16px; z-index: 2147483000;',
    '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 15px; color: #1f2937; }',
    '.wm-button { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px;',
    '  padding: 12px 18px; background: #1e3a5f; color: #ffffff; font: inherit; font-weight: 600; cursor: pointer;',
    '  box-shadow: 0 6px 20px rgba(0,0,0,.2); }',
    '.wm-button:focus-visible, .wm-close:focus-visible, .wm-link:focus-visible { outline: 3px solid #f59e0b; outline-offset: 2px; }',
    '.wm-panel { position: absolute; bottom: 60px; inset-inline-end: 0; width: min(340px, calc(100vw - 32px));',
    '  background: #ffffff; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.25); padding: 16px; box-sizing: border-box; }',
    '.wm-panel[hidden] { display: none; }',
    '.wm-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }',
    '.wm-title { margin: 0; font-size: 16px; font-weight: 700; }',
    '.wm-close { border: 0; background: transparent; font-size: 22px; line-height: 1; cursor: pointer; color: #374151; padding: 4px; }',
    '.wm-body { margin: 0 0 12px; line-height: 1.5; }',
    '.wm-link { display: inline-block; color: #1e3a5f; font-weight: 600; }',
    '@media (prefers-reduced-motion: reduce) { .wm-button { transition: none; } }'
  ].join('\n');

  function mount(cfg) {
    var t = TEXTS[cfg.lang];
    var host = el('div', { id: 'workman-assistant-host' });
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null, STYLE));

    var wrap = el('div', { class: 'wm-root', dir: t.dir, lang: cfg.lang });
    var panelId = 'wm-panel';
    var button = el('button', {
      class: 'wm-button', type: 'button', 'aria-expanded': 'false', 'aria-controls': panelId
    }, t.open);

    var panel = el('section', { class: 'wm-panel', id: panelId, 'aria-label': t.title, hidden: '' });
    var head = el('div', { class: 'wm-head' });
    var heading = el('h2', { class: 'wm-title' }, t.title);
    var close = el('button', { class: 'wm-close', type: 'button', 'aria-label': t.close }, '×');
    head.appendChild(heading);
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el('p', { class: 'wm-body' }, t.body));
    if (cfg.contactUrl) {
      panel.appendChild(el('a', { class: 'wm-link', href: cfg.contactUrl }, t.contact));
    }

    wrap.appendChild(panel);
    wrap.appendChild(button);
    root.appendChild(wrap);

    function setOpen(open) {
      panel.hidden = !open;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) close.focus(); else button.focus();
    }

    button.addEventListener('click', function () { setOpen(panel.hidden); });
    close.addEventListener('click', function () { setOpen(false); });
    wrap.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); setOpen(false); }
    });
  }

  var cfg = readConfig();
  if (!cfg.enabled) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { mount(cfg); });
  } else {
    mount(cfg);
  }
})();
