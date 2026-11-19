import { and, count, desc, eq, gte, isNull, like, lte, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { documents, users } from '../../db/schema/index.js';
import { AppError } from '../../common/errors/app-error.js';
import { storage } from '../../lib/storage.js';
import { auditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { getDocumentPolicy } from './document-registry.js';
import type { DocumentSearchQuery } from './documents.schema.js';

const columns = {
  id: documents.id,
  entityType: documents.entityType,
  entityId: documents.entityId,
  fileName: documents.fileName,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  url: documents.url,
  createdAt: documents.createdAt,
  uploadedBy: { id: users.id, name: users.name },
};

function policyFor(entityType: string) {
  const policy = getDocumentPolicy(entityType);
  if (!policy) throw AppError.badRequest(`Files cannot be attached to "${entityType}"`);
  return policy;
}

export const documentsService = {
  async assertCanRead(user: AuthUser, entityType: string, entityId: number) {
    if (!(await policyFor(entityType).canRead(user, entityId))) throw AppError.forbidden();
  },

  async list(user: AuthUser, entityType: string, entityId: number) {
    await this.assertCanRead(user, entityType, entityId);
    return db
      .select(columns)
      .from(documents)
      .innerJoin(users, eq(users.id, documents.uploadedBy))
      .where(
        and(
          eq(documents.entityType, entityType),
          eq(documents.entityId, String(entityId)),
          isNull(documents.deletedAt),
        ),
      )
      .orderBy(desc(documents.createdAt));
  },

  async upload(user: AuthUser, entityType: string, entityId: number, files: Express.Multer.File[]) {
    if (!files.length) throw AppError.badRequest('No files uploaded');
    const policy = policyFor(entityType);
    if (!(await policy.canWrite(user, entityId))) throw AppError.forbidden();
    if (policy.imagesOnly && files.some((f) => !f.mimetype.startsWith('image/'))) {
      throw AppError.badRequest('Only images can be attached here');
    }
    if (policy.maxFiles) {
      const [existing] = await db
        .select({ n: count() })
        .from(documents)
        .where(
          and(
            eq(documents.entityType, entityType),
            eq(documents.entityId, String(entityId)),
            isNull(documents.deletedAt),
          ),
        );
      if ((existing?.n ?? 0) + files.length > policy.maxFiles) {
        throw AppError.rule(`A maximum of ${policy.maxFiles} files can be attached`);
      }
    }

    const ids: number[] = [];
    for (const file of files) {
      const stored = await storage.put(
        { buffer: file.buffer, mimeType: file.mimetype, originalName: file.originalname },
        entityType,
      );
      const [res] = await db.insert(documents).values({
        entityType,
        entityId: String(entityId),
        fileName: file.originalname.slice(0, 255),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        url: stored.url,
        storageKey: stored.storageKey,
        uploadedBy: user.id,
      });
      ids.push(res.insertId);
      await auditService.log({
        action: 'create',
        entityType: 'document',
        entityId: res.insertId,
        newValues: { entityType, entityId, fileName: file.originalname },
      });
    }
    return this.list(user, entityType, entityId).then((docs) =>
      docs.filter((d) => ids.includes(d.id)),
    );
  },

  /** Soft delete (BRL-10); the file stays in storage so a Director can restore it. */
  async remove(user: AuthUser, id: number): Promise<void> {
    const [doc] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.id, id), isNull(documents.deletedAt)));
    if (!doc) throw AppError.notFound('Document');
    const canWrite = await policyFor(doc.entityType).canWrite(user, Number(doc.entityId));
    if (!canWrite && doc.uploadedBy !== user.id) throw AppError.forbidden();
    await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, id));
    await auditService.log({
      action: 'delete',
      entityType: 'document',
      entityId: id,
      oldValues: { entityType: doc.entityType, entityId: doc.entityId, fileName: doc.fileName },
    });
  },

  /**
   * Search by name, type, record and date (FR-DOC-03). Results are filtered to records the
   * user can read, so search never leaks files.
   */
  async search(user: AuthUser, query: DocumentSearchQuery) {
    const filters: SQL[] = [isNull(documents.deletedAt)];
    if (query.search) filters.push(like(documents.fileName, `%${query.search}%`));
    if (query.entityType) filters.push(eq(documents.entityType, query.entityType));
    if (query.entityId) filters.push(eq(documents.entityId, String(query.entityId)));
    if (query.mimeType) filters.push(like(documents.mimeType, `${query.mimeType}%`));
    if (query.from) filters.push(gte(documents.createdAt, new Date(`${query.from}T00:00:00Z`)));
    if (query.to) filters.push(lte(documents.createdAt, new Date(`${query.to}T23:59:59.999Z`)));

    const rows = await db
      .select(columns)
      .from(documents)
      .innerJoin(users, eq(users.id, documents.uploadedBy))
      .where(and(...filters))
      .orderBy(desc(documents.createdAt))
      .limit(500);

    const allowed = new Map<string, boolean>();
    const visible = [];
    for (const row of rows) {
      const key = `${row.entityType}:${row.entityId}`;
      if (!allowed.has(key)) {
        const policy = getDocumentPolicy(row.entityType);
        allowed.set(key, policy ? await policy.canRead(user, Number(row.entityId)) : false);
      }
      if (allowed.get(key)) visible.push(row);
      if (visible.length >= query.limit) break;
    }
    return visible;
  },
};
