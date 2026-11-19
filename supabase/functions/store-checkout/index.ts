// Señor Rey Marketplace — cobro combinado del carrito (Stripe Checkout, modo pago único).
// La clave de Stripe vive SOLO aquí, como secreto del servidor (STRIPE_SECRET_KEY).
// El catálogo y los precios mandan desde el servidor: la página nunca fija montos.
// Antes de cobrar, verifica public.store_sold: un artículo vendido NO se vuelve a cobrar.
// Método de entrega: "shipping" (pide dirección) o "pickup" (recoger, sin dirección);
// queda en metadata[method] para que store-webhook cree la orden correctamente.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CATALOG: Record<string, { name: string; amount: number }> = {
  "aretes-tiffany": {
    name: "Tiffany Victoria Vine Climber Earrings - Rose Gold with Diamonds",
    amount: 499500, // $4,995.00 USD
  },
  "prueba-10": {
    name: "Producto de prueba - Señor Rey Marketplace",
    amount: 1000, // $10.00 USD (solo para ensayar el pago combinado)
  },
  "cartera-kenzo-rue-vivienne": {
    name: "Kenzo 'Rue Vivienne' Large Bag with Strap",
    amount: 65000, // $650.00 USD
  },
  "anillo-lock-tiffany": {
    name: "Tiffany & Co. — Lock Ring — rose gold with pavé diamonds, size 6",
    amount: 240000, // $2400.00 USD
  },
  "afnan-9pm": {
    name: "Afnan — 9 PM Eau de Parfum Spray 3.4 oz — for men",
    amount: 4500, // $45.00 USD
  },
  "afnan-supremacy": {
    name: "Afnan — Supremacy In Heaven Eau de Parfum Spray 3.4 oz — for men",
    amount: 3900, // $39.00 USD
  },
  "dg-k": {
    name: "Dolce & Gabbana — K Eau de Parfum Spray 3.3 oz — for men",
    amount: 8500, // $85.00 USD
  },
  "nautica-blue": {
    name: "Nautica — Blue Eau de Toilette Spray 3.4 oz — for men",
    amount: 2200, // $22.00 USD
  },
  "amber-oud-gold": {
    name: "Al Haramain — Amber Oud Gold Edition Eau de Parfum Spray 2.0 oz — unisex",
    amount: 4500, // $45.00 USD
  },
  "lattafa-khamrah": {
    name: "Lattafa — Khamrah Eau de Parfum Spray 3.4 oz — unisex",
    amount: 4200, // $42.00 USD
  },
  "hareem-al-sultan": {
    name: "Khadlaj — Hareem Al Sultan Gold Concentrated Perfume Oil 1.18 oz — for women",
    amount: 2900, // $29.00 USD
  },
  "club-de-nuit-intense": {
    name: "Armaf — Club de Nuit Intense Man Eau de Toilette Spray 3.6 oz — for men",
    amount: 3500, // $35.00 USD
  },
  "lattafa-asad": {
    name: "Lattafa — Asad Eau de Parfum",
    amount: 3200, // $32.00 USD
  },
  "maahir-legacy": {
    name: "Lattafa — Maahir Legacy Eau de Parfum",
    amount: 3200, // $32.00 USD
  },
  "maahir-black": {
    name: "Lattafa — Maahir Black Edition Eau de Parfum",
    amount: 3200, // $32.00 USD
  },
  "aretes-bebe-14k": {
    name: "Madi K — Baby Ball Earrings 3mm — 14K yellow gold, safety screwback",
    amount: 7700, // $77.00 USD
  },
  "studs-bola-14k-6mm": {
    name: "14K Gold — Ball Stud Earrings 6mm — 14K yellow gold",
    amount: 9200, // $92.00 USD
  },
  "argollas-14k-9mm": {
    name: "Madi K — Endless Hoop Earrings 9mm — 14K yellow gold",
    amount: 7700, // $77.00 USD
  },
  "argollas-14k-15mm": {
    name: "Madi K — Endless Hoop Earrings 15mm — 14K yellow gold",
    amount: 11700, // $117.00 USD
  },
  "medalla-caridad-10k": {
    name: "10K Gold — Our Lady of Charity Medal 11.5mm — 10K yellow gold",
    amount: 15400, // $154.00 USD
  },
  "medalla-caridad-14k": {
    name: "14K Gold — Our Lady of Charity Medal 11.5mm — 14K yellow gold",
    amount: 25000, // $250.00 USD
  },
  "cadena-rope-14k-18": {
    name: "Leslie's — Rope Chain 0.8mm, 18 in — solid 14K yellow gold",
    amount: 20000, // $200.00 USD
  },
  "cadena-rope-14k-20": {
    name: "Leslie's — Rope Chain 0.8mm, 20 in — solid 14K yellow gold",
    amount: 21400, // $214.00 USD
  },
};

const STORE_URL = "https://senorrey.com/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return json({ error: "stripe_not_configured" }, 500);

  let items: unknown;
  let method = "shipping";
  try {
    const body = await req.json();
    items = body?.items;
    if (body?.method === "pickup") method = "pickup";
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!Array.isArray(items) || items.length === 0) return json({ error: "empty_cart" }, 400);

  const ids = [...new Set(items.map(String))];
  for (const id of ids) if (!CATALOG[id]) return json({ error: "unknown_item", item: id }, 400);

  // Bloqueo de vendidos: si ya se vendió, no se cobra otra vez.
  const { data: soldRows } = await admin.from('store_sold').select('item_id').in('item_id', ids);
  const sold = (soldRows ?? []).map((r) => r.item_id);
  if (sold.length) return json({ error: "sold_out", sold }, 409);

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", STORE_URL + "?pago=ok&sesion={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", STORE_URL + "?pago=cancelado");
  // Stripe Tax (activado 2026-11-17, registro FL 23-8020285035-2): calcula el
  // sales tax según la dirección del comprador; fuera de FL no cobra impuesto FL.
  form.set("automatic_tax[enabled]", "true");
  if (method === "pickup") {
    // Sin dirección de envío, Tax usa la dirección de facturación.
    form.set("billing_address_collection", "required");
  }
  if (method === "shipping") {
    form.set("shipping_address_collection[allowed_countries][0]", "US");
    // Flete por tramos según el valor del carrito (decisión de Rey, 2026-11-15):
    // < $200 -> $12 · $200-$999 -> $25 · $1,000+ -> $39 (asegurado con firma).
    const subtotalCents = ids.reduce((t, id) => t + CATALOG[id].amount, 0);
    const feeCents = subtotalCents < 20000 ? 1200 : subtotalCents < 100000 ? 2500 : 3900;
    form.set("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    form.set("shipping_options[0][shipping_rate_data][tax_behavior]", "exclusive");
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][amount]", String(feeCents));
    form.set("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
    form.set("shipping_options[0][shipping_rate_data][display_name]", "Envío asegurado con firma");
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]", "2");
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
    form.set("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]", "5");
  }
  form.set("metadata[items]", ids.join(","));
  form.set("metadata[method]", method);
  ids.forEach((id, i) => {
    const p = CATALOG[id];
    form.set(`line_items[${i}][quantity]`, "1");
    form.set(`line_items[${i}][price_data][currency]`, "usd");
    form.set(`line_items[${i}][price_data][unit_amount]`, String(p.amount));
    form.set(`line_items[${i}][price_data][product_data][name]`, p.name);
    form.set(`line_items[${i}][price_data][tax_behavior]`, "exclusive");
    form.set(`line_items[${i}][price_data][product_data][tax_code]`, "txcd_99999999"); // General - Tangible Goods
  });

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await r.json();
  if (!r.ok) return json({ error: "stripe_error", detail: data?.error?.message ?? "unknown" }, 502);
  return json({ url: data.url, id: data.id });
});
