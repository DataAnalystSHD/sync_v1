export function json(res, status, obj){
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

export function originFromReq(req){
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host  = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0];
  return `${proto}://${host}`;
}

export function methodNotAllowed(res){
  json(res, 405, { ok: false, error: "Method not allowed" });
}

export function errorResponse(res, e, status = 500){
  json(res, status, { ok: false, error: e?.message || String(e) });
}
