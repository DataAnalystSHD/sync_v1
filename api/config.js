import { json, errorResponse } from "./_lib/http.js";
import { getConfig } from "./_lib/config.js";

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    json(res, 200, {
      historySheetId: cfg.historySheetId,
      allowedDomain:  cfg.allowedDomain,
      maxRowsPerSync: cfg.maxRowsPerSync,
    });
  }catch(e){
    errorResponse(res, e);
  }
}
