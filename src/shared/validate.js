import { ZodError } from "zod";
import { badRequest } from "./errors.js";

export function parse(schema, value) {
  try {
    return schema.parse(value);
  } catch (e) {
    if (e instanceof ZodError) {
      const fields = {};
      for (const issue of e.issues) {
        const key = issue.path.join(".") || "_";
        if (!fields[key]) fields[key] = issue.message;
      }
      const first = e.issues[0];
      const where = first.path.length ? `${first.path.join(".")}: ` : "";
      throw badRequest(`${where}${first.message}`, fields);
    }
    throw e;
  }
}
