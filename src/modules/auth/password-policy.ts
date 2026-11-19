import { z } from 'zod';

/** At least 8 characters with letters and numbers (FR-USR-05). */
export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const BCRYPT_ROUNDS = 12;
