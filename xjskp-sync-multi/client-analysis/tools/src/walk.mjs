import { simple } from "acorn-walk";

export function walkJavaScript(ast, visitors) {
  simple(ast, visitors);
}
