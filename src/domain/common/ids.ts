import type { Brand } from './brand.js';

/**
 * The partition key. Every entity in this domain carries one, and no operation
 * is allowed to mix two of them — see `assertSameRetailer`.
 */
export type RetailerId = Brand<string, 'RetailerId'>;
export type StoreId = Brand<string, 'StoreId'>;
export type FacingId = Brand<string, 'FacingId'>;
export type ProductId = Brand<string, 'ProductId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type SignalId = Brand<string, 'SignalId'>;
export type EventId = Brand<string, 'EventId'>;
export type PassId = Brand<string, 'PassId'>;
export type AuditEntryId = Brand<string, 'AuditEntryId'>;
export type EmployeeId = Brand<string, 'EmployeeId'>;
export type ShopperId = Brand<string, 'ShopperId'>;
export type CarrotTagId = Brand<string, 'CarrotTagId'>;

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
export const taskId = (raw: string): TaskId => nonEmpty('TaskId', raw) as TaskId;
export const signalId = (raw: string): SignalId => nonEmpty('SignalId', raw) as SignalId;
export const eventId = (raw: string): EventId => nonEmpty('EventId', raw) as EventId;
export const passId = (raw: string): PassId => nonEmpty('PassId', raw) as PassId;
export const auditEntryId = (raw: string): AuditEntryId =>
  nonEmpty('AuditEntryId', raw) as AuditEntryId;
export const employeeId = (raw: string): EmployeeId => nonEmpty('EmployeeId', raw) as EmployeeId;
export const shopperId = (raw: string): ShopperId => nonEmpty('ShopperId', raw) as ShopperId;
export const carrotTagId = (raw: string): CarrotTagId =>
  nonEmpty('CarrotTagId', raw) as CarrotTagId;
