import type { AuthUser } from '../auth/auth.types.js';

/**
 * Attachments inherit the access rules of the record they belong to (FR-DOC-02).
 * Each module registers the entity types it allows files on, with read/write checks.
 *
 * @example
 * registerDocumentEntity('request', {
 *   label: 'Request',
 *   canRead: (user, id) => requestService.canView(user, id),
 *   canWrite: (user, id) => requestService.canAttach(user, id),
 * });
 */
export interface DocumentEntityPolicy {
  label: string;
  canRead(user: AuthUser, entityId: number): Promise<boolean>;
  canWrite(user: AuthUser, entityId: number): Promise<boolean>;
  /** Restrict to images (e.g. site photos). */
  imagesOnly?: boolean;
  /** Maximum files per record (e.g. 10 photos per report, FR-OPS-02). */
  maxFiles?: number;
}

const registry = new Map<string, DocumentEntityPolicy>();

export function registerDocumentEntity(entityType: string, policy: DocumentEntityPolicy): void {
  registry.set(entityType, policy);
}

export function getDocumentPolicy(entityType: string): DocumentEntityPolicy | undefined {
  return registry.get(entityType);
}

export function registeredDocumentEntities(): { entityType: string; label: string }[] {
  return [...registry.entries()].map(([entityType, p]) => ({ entityType, label: p.label }));
}
