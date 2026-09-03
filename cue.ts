// CUE literal rendering, shared by the derivations that emit it.

/** A CUE struct key: bare where it is an identifier, JSON-escaped otherwise.
 * CUE reads a lone backslash as an escape, and a key is whatever an author put
 * in an ir id or a program field name. */
export const quoteKey = (k: string) => (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
