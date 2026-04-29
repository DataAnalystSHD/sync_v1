import axios from "axios";
import { withBackoff, chunk, sleep } from "../retry.js";
import { getTenantAccessToken, authHeader, tableUrl, assertOk } from "./auth.js";

const PAGE_SIZE = 500;
const MAX_PAGES = 200;

async function* iterateRecordPages({ baseId, tableId, viewId, fields = true }){
  const token = await getTenantAccessToken();
  let pageToken = "";
  for(let i = 0; i < MAX_PAGES; i++){
    const r = await withBackoff(() => axios.get(tableUrl(baseId, tableId, "/records"), {
      headers: authHeader(token),
      params: {
        page_size: PAGE_SIZE,
        page_token: pageToken || undefined,
        view_id: viewId || undefined,
      },
      timeout: 30000,
    }), fields ? "larkListRecords" : "larkListIds");

    yield r.data?.data?.items || [];
    pageToken = r.data?.data?.page_token || "";
    if(!pageToken) break;
  }
}

export async function larkListAllRecords({ baseId, tableId, viewId }){
  const out = [];
  for await (const items of iterateRecordPages({ baseId, tableId, viewId })){
    out.push(...items);
  }
  out.sort((a, b) => (a.created_time || 0) - (b.created_time || 0));
  return out;
}

export async function larkBatchDeleteAll({ baseId, tableId }){
  const ids = [];
  for await (const items of iterateRecordPages({ baseId, tableId, fields: false })){
    for(const it of items) if(it.record_id) ids.push(it.record_id);
  }

  if(ids.length === 0) return { deleted: 0 };

  const token = await getTenantAccessToken();
  const url = tableUrl(baseId, tableId, "/records/batch_delete");

  await Promise.all(chunk(ids, 500).map(part =>
    withBackoff(async () => {
      const r = await axios.post(url, { records: part }, {
        headers: authHeader(token),
        timeout: 45000,
      });
      assertOk(r.data, "Lark batch_delete");
    }, "larkBatchDelete")
  ));

  return { deleted: ids.length };
}

export async function larkCreateRecordsBatched({ baseId, tableId, records }){
  const token = await getTenantAccessToken();
  const url = tableUrl(baseId, tableId, "/records/batch_create");

  let created = 0;
  for(const part of chunk(records, 500)){
    await withBackoff(async () => {
      const r = await axios.post(url, {
        records: part.map(fields => ({ fields })),
      }, {
        headers: authHeader(token),
        timeout: 45000,
      });
      assertOk(r.data, "Lark batch_create");
    }, "larkBatchCreate");
    created += part.length;
    await sleep(80);
  }

  return { created };
}
