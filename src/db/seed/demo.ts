import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { logger } from '../../config/logger.js';
import { db } from '../client.js';
import { roles, users } from '../schema/index.js';
import { ROLE_CODES, type RoleCode } from '../../rbac/default-roles.js';
import { BCRYPT_ROUNDS } from '../../modules/auth/password-policy.js';

/** One demo user per role for UAT / training. Password for all: Demo@2026 */
const DEMO_USERS: {
  name: string;
  email: string;
  phone: string;
  role: RoleCode;
  jobTitle: string;
}[] = [
  {
    name: 'Grace Uwase',
    email: 'office@njengagreens.local',
    phone: '+250780000001',
    role: ROLE_CODES.OFFICE_ADMIN,
    jobTitle: 'Office Administrator',
  },
  {
    name: 'Shruthi Nair',
    email: 'bdm@njengagreens.local',
    phone: '+250780000002',
    role: ROLE_CODES.BDM,
    jobTitle: 'Business Development Manager',
  },
  {
    name: 'Eric Mugisha',
    email: 'operations@njengagreens.local',
    phone: '+250780000003',
    role: ROLE_CODES.OPS_MANAGER,
    jobTitle: 'Operations Manager',
  },
  {
    name: 'Jean Habimana',
    email: 'tech1@njengagreens.local',
    phone: '+250780000004',
    role: ROLE_CODES.TECHNICIAN,
    jobTitle: 'Lead Technician',
  },
  {
    name: 'Patrick Nshimiye',
    email: 'tech2@njengagreens.local',
    phone: '+250780000005',
    role: ROLE_CODES.TECHNICIAN,
    jobTitle: 'Technician',
  },
  {
    name: 'Alice Mukamana',
    email: 'farm@njengagreens.local',
    phone: '+250780000006',
    role: ROLE_CODES.FARM_MANAGER,
    jobTitle: 'Farm Manager',
  },
  {
    name: 'Dr. Samuel Kato',
    email: 'agronomist@njengagreens.local',
    phone: '+250780000007',
    role: ROLE_CODES.AGRONOMIST,
    jobTitle: 'Agronomist',
  },
];

export const DEMO_PASSWORD = 'Demo@2026';

export async function seedDemoData(): Promise<void> {
  const passwordHash = await hash(DEMO_PASSWORD, BCRYPT_ROUNDS);
  for (const u of DEMO_USERS) {
    const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email));
    if (exists) continue;
    const [role] = await db.select().from(roles).where(eq(roles.code, u.role));
    await db.insert(users).values({
      name: u.name,
      email: u.email,
      phone: u.phone,
      roleId: role!.id,
      jobTitle: u.jobTitle,
      passwordHash,
      passwordChangedAt: new Date(),
    });
    logger.info(`Demo user ${u.email} (${u.role})`);
  }
}
