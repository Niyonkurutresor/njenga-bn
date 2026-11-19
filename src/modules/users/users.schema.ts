import { z } from 'zod';
import { listQuerySchema } from '../../common/http/pagination.js';
import { USER_STATUSES } from '../../db/enums.js';
import { passwordSchema } from '../auth/password-policy.js';

const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{9,15}$/, 'Enter a valid phone number');

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(150),
  email: z.email().trim().toLowerCase(),
  phone: phone.optional(),
  roleId: z.coerce.number().int().positive(),
  jobTitle: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
  password: passwordSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(150).optional(),
  email: z.email().trim().toLowerCase().optional(),
  phone: phone.nullable().optional(),
  roleId: z.coerce.number().int().positive().optional(),
  jobTitle: z.string().trim().max(100).nullable().optional(),
  department: z.string().trim().max(100).nullable().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setPasswordSchema = z.object({ password: passwordSchema });

export const userListQuerySchema = listQuerySchema.extend({
  roleId: z.coerce.number().int().positive().optional(),
  status: z.enum(USER_STATUSES).optional(),
  sortBy: z.enum(['name', 'email', 'createdAt', 'lastLoginAt']).optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

export const userOptionsQuerySchema = z.object({
  /** Only users whose role holds this permission (e.g. assignable technicians). */
  permission: z.string().max(64).optional(),
  roleCode: z.string().max(50).optional(),
  search: z.string().trim().max(100).optional(),
});
