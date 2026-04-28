import axios from "axios";
import { withBackoff } from "../retry.js";
import { getConfig } from "../config.js";
import { getTenantAccessToken, authHeader, assertOk } from "./auth.js";

export async function resolveWikiNode(wikiToken){
  const token = await getTenantAccessToken();
  const { larkApiBase } = getConfig();
  const r = await withBackoff(() => axios.get(
    `${larkApiBase}/open-apis/wiki/v2/spaces/get_node`,
    { headers: authHeader(token), params: { token: wikiToken }, timeout: 20000 }
  ), "wikiGetNode");
  assertOk(r.data, "Wiki get_node");
  const node = r.data?.data?.node;
  return {
    objToken: node?.obj_token || "",
    objType:  node?.obj_type  || "",
  };
}
