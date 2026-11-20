// store-comments — Señor Rey Marketplace product comments & reviews.
// Reviews are VERIFIED-BUYER ONLY (Rey's decision, 2026-11-19):
//   - Signed-in buyers: their account email is matched against store_orders.
//   - Guest buyers: order number + checkout email are matched against the order.
// GET  ?item=<id>            → public list of comments for the item.
// POST {action:"check", item, order_number?, email?} (+JWT for account path)
//      → {canReview, name} — used by the page to unlock the form.
// POST {item, rating, body, order_number?, email?} (+JWT for account path)
//      → re-verifies the purchase server-side, then inserts the comment
//        with verified=true and the buyer's (masked) name from the order.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function maskName(name: string | null | undefined): string {
  if (!name) return "Cliente";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Cliente";
  if (parts.length === 1) return parts[0];
  return parts[0] + " " + parts[1].charAt(0).toUpperCase() + ".";
}

function orderHasItem(items: unknown, item: string): boolean {
  if (!Array.isArray(items)) return false;
  return items.some((it) =>
    typeof it === "string" ? it === item : !!it && (it as { id?: string }).id === item
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const restHeaders: Record<string, string> = { "Content-Type": "application/json" };
  restHeaders["apikey"] = serviceKey;
  restHeaders["Authorization"] = "Bearer " + serviceKey;

  // ---------- GET: public comment list ----------
  if (req.method === "GET") {
    const item = new URL(req.url).searchParams.get("item") || "";
    if (!item) return json({ comments: [] });
    const r = await fetch(
      `${supabaseUrl}/rest/v1/store_comments?select=id,item_id,name,rating,body,created_at,verified&item_id=eq.${encodeURIComponent(item)}&order=created_at.desc&limit=100`,
      { headers: restHeaders },
    );
    if (!r.ok) return json({ error: "load_failed" }, 500);
    return json({ comments: await r.json() });
  }

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const item = String(body.item || "").trim();
  if (!item) return json({ error: "missing_item" }, 400);

  // ---------- Purchase verification ----------
  // Returns the buyer's display name (masked) or null when not a buyer.
  async function verifyBuyer(): Promise<string | null> {
    // Path A: signed-in account (JWT → email → any order with the item).
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token && token !== "anon") {
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { ["apikey"]: serviceKey, ["Authorization"]: "Bearer " + token },
      });
      if (userRes.ok) {
        const user = await userRes.json();
        const email = (user.email || "").toLowerCase();
        if (email) {
          const r = await fetch(
            `${supabaseUrl}/rest/v1/store_orders?select=buyer_name,items&buyer_email=eq.${encodeURIComponent(email)}&limit=100`,
            { headers: restHeaders },
          );
          if (r.ok) {
            const orders = await r.json();
            const hit = orders.find((o: { items: unknown }) => orderHasItem(o.items, item));
            if (hit) {
              return maskName(hit.buyer_name || user.user_metadata?.name || user.user_metadata?.full_name);
            }
          }
        }
      }
    }
    // Path B: guest proof — order number + checkout email.
    const orderNumber = String(body.order_number || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (orderNumber && email) {
      const r = await fetch(
        `${supabaseUrl}/rest/v1/store_orders?select=buyer_name,items,order_number,buyer_email&limit=10000`,
        { headers: restHeaders },
      );
      if (r.ok) {
        const orders = await r.json();
        const hit = orders.find((o: { order_number?: string; buyer_email?: string; items: unknown }) =>
          String(o.order_number || "").trim().toLowerCase() === orderNumber.toLowerCase() &&
          String(o.buyer_email || "").trim().toLowerCase() === email &&
          orderHasItem(o.items, item)
        );
        if (hit) return maskName(hit.buyer_name);
      }
    }
    return null;
  }

  // ---------- Check (unlock the form) ----------
  if (body.action === "check") {
    const name = await verifyBuyer();
    return json(name ? { canReview: true, name } : { canReview: false });
  }

  // ---------- Submit (re-verify, then insert) ----------
  const name = await verifyBuyer();
  if (!name) return json({ error: "not_a_buyer" }, 403);

  const rating = Math.max(1, Math.min(5, Math.round(Number(body.rating) || 0)));
  const text = String(body.body || "").trim().slice(0, 600);
  if (!text) return json({ error: "empty_body" }, 400);

  const ins = await fetch(`${supabaseUrl}/rest/v1/store_comments`, {
    method: "POST",
    headers: { ...restHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ item_id: item, name, rating, body: text, verified: true }),
  });
  if (!ins.ok) return json({ error: "insert_failed" }, 500);
  const rows = await ins.json();
  return json({ comment: rows[0] });
});
