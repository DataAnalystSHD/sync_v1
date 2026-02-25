import { json, getConfig } from "./_util.js";

export default async function handler(req, res){
  try{
    const cfg = getConfig();
    json(res, 200, {
      historySheetId: cfg.historySheetId,
      allowedDomain: cfg.allowedDomain,
      maxRowsPerSync: cfg.maxRowsPerSync
    });
  }catch(e){
    json(res, 500, { ok:false, error: e.message });
  }
}