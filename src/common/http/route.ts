import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';
import type { AuthUser } from '../../modules/auth/auth.types.js';
import { Paginated } from './pagination.js';

interface RouteSchemas<B extends z.ZodType, Q extends z.ZodType, P extends z.ZodType> {
  body?: B;
  query?: Q;
  params?: P;
  /** HTTP status for a successful response (default 200). */
  status?: number;
}

export interface RouteContext<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  /** Present on routes behind `authenticate`; use `requireUser` in handlers that need it. */
  user: AuthUser;
  req: Request;
  res: Response;
}

type Infer<S> = S extends z.ZodType ? z.output<S> : undefined;

function parse<S extends z.ZodType>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const flat = z.flattenError(result.error);
    throw AppError.validation({ in: where, fields: flat.fieldErrors, form: flat.formErrors });
  }
  return result.data;
}

/**
 * Typed controller wrapper: validates body/query/params with Zod, runs the handler and
 * serialises the result as `{ data }` (or `{ data, meta }` for `Paginated`).
 * Handlers that stream a file write to `res` themselves and return nothing.
 *
 * @example
 * router.post('/', authorize(P.REQUESTS_CREATE),
 *   route({ body: createRequestSchema, status: 201 }, ({ body, user }) => requestService.create(body, user)));
 */
export function route<
  B extends z.ZodType = z.ZodUndefined,
  Q extends z.ZodType = z.ZodUndefined,
  P extends z.ZodType = z.ZodUndefined,
>(
  schemas: RouteSchemas<B, Q, P>,
  handler: (ctx: RouteContext<Infer<B>, Infer<Q>, Infer<P>>) => unknown,
): RequestHandler {
  return async (req, res) => {
    const ctx = {
      body: schemas.body ? parse(schemas.body, req.body ?? {}, 'body') : undefined,
      query: schemas.query ? parse(schemas.query, req.query, 'query') : undefined,
      params: schemas.params ? parse(schemas.params, req.params, 'params') : undefined,
      user: req.user as AuthUser,
      req,
      res,
    } as RouteContext<Infer<B>, Infer<Q>, Infer<P>>;

    const result = await handler(ctx);
    if (res.headersSent) return;

    if (result instanceof Paginated) {
      res.status(schemas.status ?? 200).json({ data: result.data, meta: result.meta });
    } else if (result === undefined && schemas.status === 204) {
      res.status(204).end();
    } else {
      res.status(schemas.status ?? 200).json({ data: result ?? null });
    }
  };
}
