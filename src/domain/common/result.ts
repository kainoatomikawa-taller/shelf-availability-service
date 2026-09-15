export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is { ok: true; value: T } => result.ok;

/** Unwraps a result, throwing the error when it is a failure. For call sites that treat a failure as a bug. */
export const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.ok) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
};
