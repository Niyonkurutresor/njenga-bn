import {
  boolean,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, dateTime, id, ref, softDelete } from './_columns.js';
import { users } from './auth.js';

/** Read-only audit trail (FR-AUD-01..03). */
export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: id(),
    userId: ref('user_id').references(() => users.id),
    action: varchar('action', { length: 40 }).notNull(),
    entityType: varchar('entity_type', { length: 60 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }),
    oldValues: json('old_values').$type<Record<string, unknown> | null>(),
    newValues: json('new_values').$type<Record<string, unknown> | null>(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId),
    index('audit_user_idx').on(t.userId),
    index('audit_created_idx').on(t.createdAt),
  ],
);

/** In-app notifications (FR-NTF-01). */
export const notifications = mysqlTable(
  'notifications',
  {
    id: id(),
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 60 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body'),
    link: varchar('link', { length: 255 }),
    entityType: varchar('entity_type', { length: 60 }),
    entityId: varchar('entity_id', { length: 64 }),
    readAt: dateTime('read_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notif_user_read_idx').on(t.userId, t.readAt)],
);

/** Per-user opt-out for non-critical notification channels (FR-NTF-04). */
export const notificationPreferences = mysqlTable(
  'notification_preferences',
  {
    userId: ref('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 60 }).notNull(),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    smsEnabled: boolean('sms_enabled').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
);

/** Files attached to any record (FR-DOC-01..03). */
export const documents = mysqlTable(
  'documents',
  {
    id: id(),
    entityType: varchar('entity_type', { length: 60 }).notNull(),
    entityId: varchar('entity_id', { length: 64 }).notNull(),
    fileName: varchar('file_name', { length: 255 }).notNull(),
    mimeType: varchar('mime_type', { length: 120 }).notNull(),
    sizeBytes: int('size_bytes').notNull(),
    url: varchar('url', { length: 500 }).notNull(),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    uploadedBy: ref('uploaded_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    ...softDelete(),
  },
  (t) => [index('documents_entity_idx').on(t.entityType, t.entityId)],
);

/** Named counters for human-readable references (REQ-2026-0001, PRJ-2026-001). */
export const sequences = mysqlTable('sequences', {
  name: varchar('name', { length: 40 }).primaryKey(),
  value: int('value').notNull().default(0),
});
