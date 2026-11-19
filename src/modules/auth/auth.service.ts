import { createHash, randomBytes } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { db } from '../../db/client.js';
import { passwordResetTokens, roles, users } from '../../db/schema/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/app-error.js';
import { renderEmail, sendMail } from '../../lib/mailer.js';
import { sendSms } from '../../lib/sms.js';
import { auditService } from '../audit/audit.service.js';
import { rolesService } from '../roles/roles.service.js';
import { BCRYPT_ROUNDS } from './password-policy.js';
import type { LoginInput } from './auth.schema.js';
import type { AuthUser, JwtPayload, SessionUser } from './auth.types.js';

const INVALID_CREDENTIALS = 'Invalid email/phone or password';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

type UserRow = typeof users.$inferSelect;

/** Hash compared against when the account does not exist, to equalise timing. */
let dummyHash: Promise<string> | undefined;

function findByIdentifier(identifier: string) {
  const value = identifier.trim();
  return db
    .select()
    .from(users)
    .where(or(eq(users.email, value.toLowerCase()), eq(users.phone, value)))
    .limit(1)
    .then((rows) => rows[0]);
}

async function toSessionUser(user: UserRow): Promise<SessionUser> {
  const access = await rolesService.getRoleAccess(user.roleId);
  if (!access) throw AppError.unauthorized('User role no longer exists');
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    jobTitle: user.jobTitle,
    department: user.department,
    role: { id: user.roleId, code: access.code, name: access.name },
    permissions: access.permissions,
    lastLoginAt: user.lastLoginAt,
  };
}

export const authService = {
  async login(input: LoginInput): Promise<{ token: string; user: SessionUser }> {
    const user = await findByIdentifier(input.identifier);

    if (!user) {
      // Still spend bcrypt time so response time does not reveal unknown accounts.
      dummyHash ??= hash('not-a-real-password', BCRYPT_ROUNDS);
      await compare(input.password, await dummyHash);
      throw AppError.unauthorized(INVALID_CREDENTIALS);
    }
    if (user.status !== 'active') {
      throw AppError.unauthorized('This account has been deactivated');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw AppError.locked(
        `Account locked after too many failed attempts. Try again in ${minutes} min.`,
      );
    }

    if (!(await compare(input.password, user.passwordHash))) {
      // Lock for 15 minutes after 5 failed attempts (NFR-06).
      const attempts = user.failedLoginAttempts + 1;
      const lock = attempts >= env.LOGIN_MAX_ATTEMPTS;
      await db
        .update(users)
        .set({
          failedLoginAttempts: lock ? 0 : attempts,
          lockedUntil: lock ? new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60_000) : null,
        })
        .where(eq(users.id, user.id));
      await auditService.log({
        action: 'login_failed',
        entityType: 'user',
        entityId: user.id,
        userId: user.id,
        newValues: { attempts, locked: lock },
      });
      if (lock) {
        throw AppError.locked(
          `Account locked for ${env.LOGIN_LOCK_MINUTES} minutes after ${env.LOGIN_MAX_ATTEMPTS} failed attempts`,
        );
      }
      throw AppError.unauthorized(INVALID_CREDENTIALS);
    }

    const now = new Date();
    await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now })
      .where(eq(users.id, user.id));
    await auditService.log({
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
    });

    const token = jwt.sign({ sub: String(user.id) }, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as NonNullable<SignOptions['expiresIn']>,
    });
    return { token, user: await toSessionUser({ ...user, lastLoginAt: now }) };
  },

  async verifyToken(token: string): Promise<AuthUser> {
    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch {
      throw AppError.unauthorized('Session expired, please sign in again');
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, Number(payload.sub)));
    if (!user || user.status !== 'active') throw AppError.unauthorized('Account is not active');
    // Tokens issued before a password change are revoked.
    if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime() - 1000) {
      throw AppError.unauthorized('Session expired, please sign in again');
    }

    const access = await rolesService.getRoleAccess(user.roleId);
    if (!access) throw AppError.unauthorized('User role no longer exists');
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      roleId: user.roleId,
      roleCode: access.code,
      roleName: access.name,
      permissions: access.permissions,
    };
  },

  async session(userId: number): Promise<SessionUser> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) throw AppError.unauthorized();
    return toSessionUser(user);
  },

  async updateProfile(
    userId: number,
    input: { name?: string | undefined; phone?: string | null | undefined },
  ) {
    const [before] = await db.select().from(users).where(eq(users.id, userId));
    if (!before) throw AppError.notFound('User');
    const patch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
    };
    await db.update(users).set(patch).where(eq(users.id, userId));
    await auditService.log({
      action: 'update',
      entityType: 'user',
      entityId: userId,
      oldValues: { name: before.name, phone: before.phone },
      newValues: patch,
    });
    return this.session(userId);
  },

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user || !(await compare(currentPassword, user.passwordHash))) {
      throw AppError.rule('Current password is incorrect');
    }
    await db
      .update(users)
      .set({ passwordHash: await hash(newPassword, BCRYPT_ROUNDS), passwordChangedAt: new Date() })
      .where(eq(users.id, userId));
    await auditService.log({ action: 'password_change', entityType: 'user', entityId: userId });
  },

  /**
   * Sends a single-use reset link by email (and SMS when a phone is on file) (FR-USR-06).
   * Always succeeds from the caller's view so accounts cannot be enumerated.
   */
  async forgotPassword(identifier: string): Promise<void> {
    const user = await findByIdentifier(identifier);
    if (!user || user.status !== 'active') return;

    const token = randomBytes(32).toString('base64url');
    await db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + env.RESET_TOKEN_EXPIRES_MINUTES * 60_000),
    });

    const link = `${env.FRONTEND_URL}/reset-password?token=${token}`;
    const body = `A password reset was requested for your account. The link expires in ${env.RESET_TOKEN_EXPIRES_MINUTES} minutes. If you did not request it, ignore this message.`;
    sendMail({
      to: user.email,
      subject: 'Reset your NGL password',
      text: `${body}\n\n${link}`,
      html: renderEmail('Reset your password', body, link),
    }).catch((err: unknown) => logger.error({ err }, 'Reset email failed'));
    if (user.phone) {
      sendSms(user.phone, `NGL password reset: ${link}`).catch((err: unknown) =>
        logger.error({ err }, 'Reset SMS failed'),
      );
    }
  },

  async resetPassword(token: string, password: string): Promise<void> {
    const now = new Date();
    const [record] = await db
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, sha256(token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      );
    if (!record) throw AppError.rule('This reset link is invalid or has expired');

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: await hash(password, BCRYPT_ROUNDS),
          passwordChangedAt: now,
          failedLoginAttempts: 0,
          lockedUntil: null,
        })
        .where(eq(users.id, record.userId));
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(eq(passwordResetTokens.userId, record.userId));
      await auditService.log(
        {
          action: 'password_reset',
          entityType: 'user',
          entityId: record.userId,
          userId: record.userId,
        },
        tx,
      );
    });
  },

  /** Returns the role row for a code — used by the seed and tests. */
  async roleByCode(code: string) {
    const [role] = await db.select().from(roles).where(eq(roles.code, code));
    return role;
  },
};
