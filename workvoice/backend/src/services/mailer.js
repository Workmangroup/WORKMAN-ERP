import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transport = env.smtp.host
  ? nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
    })
  : null;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function template({ titre, message, lien }) {
  const url = lien ? `${env.frontendUrl}${lien}` : env.frontendUrl;
  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
    <div style="background:#0b3d91;color:#fff;padding:16px 24px;font-weight:600;font-size:18px">
      WORKVOICE <span style="color:#ffc20e">·</span> Portail Collaborateur Workman
    </div>
    <div style="padding:24px;color:#111827">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtml(titre)}</h2>
      <p style="margin:0 0 24px;line-height:1.5">${escapeHtml(message)}</p>
      <a href="${escapeHtml(url)}" style="background:#ffc20e;color:#0b3d91;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">
        Ouvrir WORKVOICE
      </a>
    </div>
    <div style="background:#f3f4f6;padding:12px 24px;font-size:12px;color:#6b7280">
      Message automatique — merci de ne pas répondre.
    </div>
  </div>`;
}

/** Envoie un e-mail ; sans SMTP configuré, l'e-mail est affiché dans la console. */
export async function sendMail({ to, titre, message, lien }) {
  if (!to) return;
  if (!transport) {
    console.info(`[mail:dev] → ${to} | ${titre} | ${message}`);
    return;
  }
  await transport.sendMail({
    from: env.smtp.from,
    to,
    subject: `[WORKVOICE] ${titre}`,
    text: `${message}\n\n${env.frontendUrl}${lien ?? ''}`,
    html: template({ titre, message, lien }),
  });
}
