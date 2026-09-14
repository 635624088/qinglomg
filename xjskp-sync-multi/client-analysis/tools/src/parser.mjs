import { parse } from "acorn";

export class ClientAnalysisSyntaxError extends Error {
  constructor(cause) {
    super(`JavaScript syntax error at ${cause.loc.line}:${cause.loc.column}: ${cause.message}`, { cause });
    this.name = "ClientAnalysisSyntaxError";
    this.code = "CLIENT_ANALYSIS_SYNTAX_ERROR";
    this.line = cause.loc.line;
    this.column = cause.loc.column;
    this.pos = cause.pos;
  }
}

export function parseJavaScript(source, options = {}) {
  try {
    return parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true, ...options });
  } catch (error) {
    if (error?.loc && Number.isInteger(error.pos)) throw new ClientAnalysisSyntaxError(error);
    throw error;
  }
}
