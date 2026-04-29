import axios from "axios";

/**
 * Post a message to a Lark/Feishu custom bot webhook.
 * No app permissions or scopes needed — the webhook is a per-chat URL.
 *
 * Set LARK_NOTIFY_WEBHOOK to enable. Optional LARK_NOTIFY_ON=errors limits
 * to error-only notifications (default: send for both success and error).
 */
export async function notifyLarkBot({ title, lines = [], success = true }){
  const url = process.env.LARK_NOTIFY_WEBHOOK;
  if(!url) return;
  const mode = (process.env.LARK_NOTIFY_ON || "all").toLowerCase();
  if(mode === "errors" && success) return;
  if(mode === "none") return;

  const headerColor = success ? "green" : "red";
  const card = {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: title || (success ? "✅ Sync complete" : "❌ Sync failed") },
        template: headerColor,
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: lines.length ? lines.join("\n") : "(no details)",
          },
        },
      ],
    },
  };

  try {
    await axios.post(url, card, { timeout: 10000 });
  } catch(e){
    console.warn("[notifyLarkBot] failed:", e?.message || e);
  }
}

export function summarizeBatch(results){
  const ok    = results.filter(r => r.status === "success").length;
  const fail  = results.filter(r => r.status === "error").length;
  const total = results.length;
  return { ok, fail, total };
}
