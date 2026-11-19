import { getTableName, sql, type AnyColumn, type SQL } from 'drizzle-orm';

/**
 * A column of the OUTER query, always written as `table`.`column`, for use inside a correlated
 * subquery written in raw SQL. Drizzle leaves the table name out of single-table selects, so a
 * plain `${projects.id}` renders as `id` and MySQL binds it to the subquery's own `id` column.
 */
export function outerColumn(column: AnyColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}
