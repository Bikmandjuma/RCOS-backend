// Every response uses the same envelope: { statusCode, message, data }
export function ok(res, data = null, message = "OK", status = 200) {
  return res.status(status).json({ statusCode: status, message, data });
}
export const created = (res, data, message = "Created") => ok(res, data, message, 201);
