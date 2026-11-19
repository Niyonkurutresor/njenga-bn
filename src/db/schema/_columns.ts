import { sql } from 'drizzle-orm';
import { bigint, datetime, decimal, mysqlEnum } from 'drizzle-orm/mysql-core';
import { COST_CENTRE_TYPES } from '../enums.js';

/** Auto-increment BIGINT UNSIGNED primary key. */
export const id = () =>
  bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey();

/** BIGINT UNSIGNED column for foreign keys. */
export const ref = (name: string) => bigint(name, { mode: 'number', unsigned: true });

/** Money in RWF: DECIMAL(15,2), returned as a JS number. */
export const money = (name: string) => decimal(name, { precision: 15, scale: 2, mode: 'number' });

/** Quantity with 3 decimals (kg, litres, units). */
export const quantity = (name: string) =>
  decimal(name, { precision: 14, scale: 3, mode: 'number' });

export const dateTime = (name: string) => datetime(name, { mode: 'date', fsp: 3 });

export const createdAt = () =>
  dateTime('created_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP(3))`);

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: dateTime('updated_at')
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP(3))`)
    .$onUpdate(() => new Date()),
});

/** Soft deletion (FR-AUD-04, BRL-10). */
export const softDelete = () => ({ deletedAt: dateTime('deleted_at') });

export const costCentreType = (name = 'cost_centre_type') => mysqlEnum(name, COST_CENTRE_TYPES);
