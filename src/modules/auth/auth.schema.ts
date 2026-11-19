import { z } from 'zod';
import { passwordSchema } from './password-policy.js';

/** Login with email or phone number (FR-USR-04). */
export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or phone number').max(191),
  password: z.string().min(1, 'Password is required').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3).max(191),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{9,15}$/, 'Enter a valid phone number')
    .nullable()
    .optional(),
});
