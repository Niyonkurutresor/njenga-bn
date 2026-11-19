import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/** Sends an SMS for urgent items (FR-NTF-03). With SMS_PROVIDER=log it is only logged. */
export async function sendSms(to: string, text: string): Promise<void> {
  if (env.SMS_PROVIDER === 'log') {
    logger.info({ to, text }, '[sms:log]');
    return;
  }

  const res = await fetch('https://api.pindo.io/v1/sms/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SMS_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, text: text.slice(0, 459), sender: env.SMS_SENDER_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`SMS provider responded ${res.status}: ${await res.text()}`);
  }
}
