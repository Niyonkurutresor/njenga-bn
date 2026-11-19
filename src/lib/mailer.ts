import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport(
    env.MAIL_SERVICE
      ? { service: env.MAIL_SERVICE, auth: { user: env.MAIL_USER, pass: env.MAIL_PASSWORD } }
      : {
          host: env.MAIL_HOST,
          port: env.MAIL_PORT,
          secure: env.MAIL_PORT === 465,
          auth: { user: env.MAIL_USER, pass: env.MAIL_PASSWORD },
        },
  );
  return transporter;
}

/** Sends an email. With MAIL_PROVIDER=log the message is only logged (development). */
export async function sendMail(message: MailMessage): Promise<void> {
  if (env.MAIL_PROVIDER === 'log') {
    logger.info({ to: message.to, subject: message.subject, text: message.text }, '[mail:log]');
    return;
  }
  await getTransporter().sendMail({ from: env.MAIL_FROM, ...message });
}

/** Minimal branded HTML wrapper for notification emails. */
export function renderEmail(title: string, body: string, actionUrl?: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>');
  const button = actionUrl
    ? `<p style="margin:24px 0"><a href="${encodeURI(actionUrl)}" style="background:#2f6b3a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open in NGL</a></p>`
    : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:auto;color:#1f2937">
  <div style="border-bottom:3px solid #2f6b3a;padding:12px 0;font-weight:700;color:#2f6b3a;letter-spacing:2px">NJENGA GREENS</div>
  <h2 style="font-size:18px">${esc(title)}</h2><p>${esc(body)}</p>${button}
  <p style="color:#6b7280;font-size:12px">${esc(env.APP_NAME)}</p></div>`;
}
