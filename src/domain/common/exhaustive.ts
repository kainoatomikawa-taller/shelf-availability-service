/** Compile-time proof that a discriminated union switch covers every member. */
export const assertNever = (value: never, context: string): never => {
  throw new Error(`Unhandled variant in ${context}: ${JSON.stringify(value)}`);
};
