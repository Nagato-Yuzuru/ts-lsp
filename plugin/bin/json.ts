export type JsonObject = { readonly [key: string]: unknown };

export const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null;
