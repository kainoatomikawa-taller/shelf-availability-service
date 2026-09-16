import type { Brand } from './brand';

/**
 * Identifiers as the dashboard sees them.
 *
 * Every one is an opaque UTF-8 string on the wire (`WIRE_ENCODING.identifiers`),
 * so the dashboard never parses, splits or orders them — it brands them on
 * decode and passes them back verbatim.
 */
export type RetailerId = Brand<string, 'RetailerId'>;
export type StoreId = Brand<string, 'StoreId'>;
export type FacingId = Brand<string, 'FacingId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type DepartmentId = Brand<string, 'DepartmentId'>;
export type CategoryId = Brand<string, 'CategoryId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type EmployeeId = Brand<string, 'EmployeeId'>;
export type QueueId = Brand<string, 'QueueId'>;

const nonEmpty = (kind: string, raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${kind} must be a non-empty string`);
  }
  return trimmed;
};

export const retailerId = (raw: string): RetailerId => nonEmpty('RetailerId', raw) as RetailerId;
export const storeId = (raw: string): StoreId => nonEmpty('StoreId', raw) as StoreId;
export const facingId = (raw: string): FacingId => nonEmpty('FacingId', raw) as FacingId;
export const productId = (raw: string): ProductId => nonEmpty('ProductId', raw) as ProductId;
export const departmentId = (raw: string): DepartmentId =>
  nonEmpty('DepartmentId', raw) as DepartmentId;
export const categoryId = (raw: string): CategoryId => nonEmpty('CategoryId', raw) as CategoryId;
export const taskId = (raw: string): TaskId => nonEmpty('TaskId', raw) as TaskId;
export const employeeId = (raw: string): EmployeeId => nonEmpty('EmployeeId', raw) as EmployeeId;
export const queueId = (raw: string): QueueId => nonEmpty('QueueId', raw) as QueueId;
