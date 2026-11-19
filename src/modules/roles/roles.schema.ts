import { z } from 'zod';
import { ALL_PERMISSIONS, type Permission } from '../../rbac/permissions.js';

const permissionList = z
  .array(z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]))
  .transform((list) => [...new Set(list)]);

export const createRoleSchema = z.object({
  code: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{1,49}$/, 'Use lowercase letters, numbers and underscores'),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  permissions: permissionList.default([]),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: permissionList.optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
