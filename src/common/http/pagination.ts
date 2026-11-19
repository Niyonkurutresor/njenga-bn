import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;

/** Standard list query params. Extend with `.extend({...})` for module filters. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  search: z.string().trim().max(100).optional(),
  sortBy: z.string().max(40).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Marker result: the route helper serialises it as `{ data, meta }`. */
export class Paginated<T> {
  constructor(
    public readonly data: T[],
    public readonly meta: PageMeta,
  ) {}
}

export function paginated<T>(
  data: T[],
  total: number,
  query: Pick<ListQuery, 'page' | 'pageSize'>,
): Paginated<T> {
  return new Paginated(data, {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
  });
}

export function offsetOf(query: Pick<ListQuery, 'page' | 'pageSize'>): number {
  return (query.page - 1) * query.pageSize;
}

/** Common optional date-range filter (`from`/`to` as YYYY-MM-DD). */
export const dateRangeSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

/** Coerces "true"/"false" query strings. */
export const queryBoolean = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
