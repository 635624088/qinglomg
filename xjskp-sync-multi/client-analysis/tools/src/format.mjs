import { generate } from "astring";

export function formatJavaScript(ast) {
  return generate(ast);
}
