import { hash } from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { closeDb, db } from '../client.js';
import { categories, rolePermissions, roles, users } from '../schema/index.js';
import { DEFAULT_ROLES, ROLE_CODES } from '../../rbac/default-roles.js';
import { BCRYPT_ROUNDS } from '../../modules/auth/password-policy.js';
import { seedDemoData } from './demo.js';

/** Default categories (FR-FIN-02); Office Admin can add more. */
const DEFAULT_CATEGORIES = {
  expense: [
    'Materials',
    'Transport',
    'Labour',
    'Fuel',
    'Utilities',
    'Farm inputs',
    'Office supplies',
    'Salaries',
    'Casual labour',
    'Equipment',
    'Maintenance',
    'Communication',
    'Inventory purchase',
    'Loan repayment',
    'Other',
  ],
  income: ['Project revenue', 'Farm produce sales', 'Loan received', 'Other income'],
} as const;

/**
 * Idempotent base seed: roles (permissions only applied to roles that have none yet, so
 * Director customisations survive re-runs), categories and the first Director account.
 */
async function seedBase() {
  for (const def of DEFAULT_ROLES) {
    let [role] = await db.select().from(roles).where(eq(roles.code, def.code));
    if (!role) {
      const [res] = await db
        .insert(roles)
        .values({ code: def.code, name: def.name, description: def.description, isSystem: true });
      [role] = await db.select().from(roles).where(eq(roles.id, res.insertId));
      logger.info(`Created role ${def.name}`);
    }
    const existing = await db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, role!.id));
    if (!existing.length) {
      await db
        .insert(rolePermissions)
        .values(def.permissions.map((permission) => ({ roleId: role!.id, permission })));
      logger.info(`Granted ${def.permissions.length} permissions to ${def.name}`);
    }
  }

  for (const [kind, names] of Object.entries(DEFAULT_CATEGORIES) as [
    keyof typeof DEFAULT_CATEGORIES,
    readonly string[],
  ][]) {
    for (const name of names) {
      const [found] = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.name, name), eq(categories.kind, kind)));
      if (!found) await db.insert(categories).values({ name, kind });
    }
  }

  const [director] = await db.select().from(users).where(eq(users.email, env.SEED_DIRECTOR_EMAIL));
  if (!director) {
    const [role] = await db.select().from(roles).where(eq(roles.code, ROLE_CODES.DIRECTOR));
    await db.insert(users).values({
      name: env.SEED_DIRECTOR_NAME,
      email: env.SEED_DIRECTOR_EMAIL,
      passwordHash: await hash(env.SEED_DIRECTOR_PASSWORD, BCRYPT_ROUNDS),
      roleId: role!.id,
      jobTitle: 'Director',
      passwordChangedAt: new Date(),
    });
    logger.info(`Created Director account ${env.SEED_DIRECTOR_EMAIL}`);
  }
}

async function main() {
  await seedBase();
  if (process.argv.includes('--demo')) await seedDemoData();
  logger.info('Seed complete');
}

main()
  .catch((err: unknown) => {
    logger.fatal({ err }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
