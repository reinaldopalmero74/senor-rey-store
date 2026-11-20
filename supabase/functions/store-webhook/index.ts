// Supabase Edge Function: store-webhook (Señor Rey Marketplace)
// Stripe avisa aquí cada pago completado; la función marca los
// artículos como vendidos en public.store_sold y crea la orden en
// public.store_orders (número SRS-####, datos del comprador y de
// envío, método shipping/pickup). Firma verificada contra
// STORE_WEBHOOK_SECRET. Desplegar SIN verificación JWT.
//
// Confirmación instantánea (2026-11-19): tras crear la orden, si
// RESEND_API_KEY está configurada y la orden aún no tiene
// email_confirm_at, envía la confirmación al instante desde
// ventas@senorrey.com vía Resend y marca email_confirm_at. El cron
// store-order-emails (cada 30 min, desde el buzón de Ralph) queda
// como respaldo y salta las órdenes ya marcadas. Un fallo de correo
// NUNCA tumba el webhook: la orden ya quedó guardada.
//
// REGLA: NAMES debe llevar el mismo nombre que el CATÁLOGO de
// store-checkout para cada producto (id → nombre exacto).
import { createClient } from 'npm:@supabase/supabase-js@2';
import Stripe from 'npm:stripe';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { apiVersion: '2024-06-20' });
const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
);
const resendKey = Deno.env.get('RESEND_API_KEY') ?? '';

const NAMES: Record<string, string> = {
  'aretes-tiffany': 'Tiffany Victoria Vine Climber Earrings - Rose Gold with Diamonds',
  'prueba-10': 'Producto de prueba - Señor Rey Marketplace',
  'cartera-kenzo-rue-vivienne': "Kenzo 'Rue Vivienne' Large Bag with Strap",
  'anillo-lock-tiffany': 'Tiffany & Co. — Lock Ring — rose gold with pavé diamonds, size 6',
  'afnan-9pm': 'Afnan — 9 PM Eau de Parfum Spray 3.4 oz — for men',
  'afnan-supremacy': 'Afnan — Supremacy In Heaven Eau de Parfum Spray 3.4 oz — for men',
  'dg-k': 'Dolce & Gabbana — K Eau de Parfum Spray 3.3 oz — for men',
  'nautica-blue': 'Nautica — Blue Eau de Toilette Spray 3.4 oz — for men',
  'amber-oud-gold': 'Al Haramain — Amber Oud Gold Edition Eau de Parfum Spray 2.0 oz — unisex',
  'lattafa-khamrah': 'Lattafa — Khamrah Eau de Parfum Spray 3.4 oz — unisex',
  'hareem-al-sultan': 'Khadlaj — Hareem Al Sultan Gold Concentrated Perfume Oil 1.18 oz — for women',
  'club-de-nuit-intense': 'Armaf — Club de Nuit Intense Man Eau de Toilette Spray 3.6 oz — for men',
  'lattafa-asad': 'Lattafa — Asad Eau de Parfum',
  'maahir-legacy': 'Lattafa — Maahir Legacy Eau de Parfum',
  'maahir-black': 'Lattafa — Maahir Black Edition Eau de Parfum',
  'aretes-bebe-14k': 'Madi K — Baby Ball Earrings 3mm — 14K yellow gold, safety screwback',
  'studs-bola-14k-6mm': '14K Gold — Ball Stud Earrings 6mm — 14K yellow gold',
  'argollas-14k-9mm': 'Madi K — Endless Hoop Earrings 9mm — 14K yellow gold',
  'argollas-14k-15mm': 'Madi K — Endless Hoop Earrings 15mm — 14K yellow gold',
  'medalla-caridad-10k': '10K Gold — Our Lady of Charity Medal 11.5mm — 10K yellow gold',
  'medalla-caridad-14k': '14K Gold — Our Lady of Charity Medal 11.5mm — 14K yellow gold',
  'cadena-rope-14k-18': "Leslie's — Rope Chain 0.8mm, 18 in — solid 14K yellow gold",
  'cadena-rope-14k-20': "Leslie's — Rope Chain 0.8mm, 20 in — solid 14K yellow gold",
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function money(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const sig = req.headers.get('stripe-signature');
  const secret = Deno.env.get('STORE_WEBHOOK_SECRET') ?? '';
  if (!sig || !secret) return new Response('missing signature/secret', { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await req.text(), sig, secret);
  } catch {
    return new Response('bad signature', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === 'paid' || session.status === 'complete') {
      let items: string[] = [];
      const fromMeta = session.metadata?.items ?? session.metadata?.item_id;
      if (fromMeta) items = fromMeta.split(',').map((s) => s.trim()).filter(Boolean);
      if (!items.length && session.payment_link) {
        try {
          const link = await stripe.paymentLinks.retrieve(String(session.payment_link));
          const id = link.metadata?.item_id;
          if (id) items = [id];
        } catch { /* sin metadata: nada que marcar */ }
      }
      for (const item_id of items) {
        await admin.from('store_sold').upsert(
          { item_id, session_id: session.id, source: session.payment_link ? 'payment_link' : 'cart' },
          { onConflict: 'item_id' }
        );
      }
      // Si la venta vino de un Payment Link directo, desactivarlo para que
      // nadie más pueda pagar esa pieza única (no fatal si falla).
      if (session.payment_link) {
        try {
          await stripe.paymentLinks.update(String(session.payment_link), { active: false });
        } catch { /* el link puede ser de otra cuenta/modo: la orden ya quedó registrada */ }
      }
      // Crear la orden (idempotente por session_id: si Stripe reintenta, no duplica).
      if (items.length) {
        const cd = session.customer_details;
        const sx = session as unknown as {
          shipping_details?: { name?: string; address?: unknown };
          collected_information?: { shipping_details?: { name?: string; address?: unknown } };
        };
        const sd = sx.shipping_details ?? sx.collected_information?.shipping_details;
        const { error } = await admin.from('store_orders').upsert(
          {
            session_id: session.id,
            items: items.map((id) => ({ id, name: NAMES[id] ?? id })),
            total_cents: session.amount_total ?? 0,
            buyer_email: cd?.email ?? null,
            buyer_name: cd?.name ?? null,
            ship_name: sd?.name ?? cd?.name ?? null,
            ship_address: sd?.address ?? null,
            method: session.metadata?.method === 'pickup' ? 'pickup' : 'shipping',
            status: 'paid',
          },
          { onConflict: 'session_id', ignoreDuplicates: true }
        );
        if (error) return new Response('order insert failed', { status: 500 });

        // ——— Confirmación instantánea vía Resend (ventas@senorrey.com) ———
        // Solo si la orden aún no fue confirmada por correo. Al enviar con
        // éxito se marca email_confirm_at y el cron de respaldo la salta.
        if (resendKey && cd?.email) {
          try {
            const { data: ord } = await admin.from('store_orders')
              .select('order_number, buyer_name, items, total_cents, method, email_confirm_at')
              .eq('session_id', session.id)
              .maybeSingle();
            if (ord && !ord.email_confirm_at) {
              const num = String(ord.order_number ?? '');
              const total = Number(ord.total_cents ?? 0);
              const ordItems = (ord.items ?? []) as { id: string; name: string }[];
              const itemLines = ordItems.map((i) => '• ' + (i.name ?? i.id)).join('\n');
              const itemRows = ordItems.map((i) => `<li style="margin:4px 0">${esc(String(i.name ?? i.id))}</li>`).join('');
              const first = String(ord.buyer_name ?? cd.name ?? '').split(' ')[0];
              const tierEs = total >= 100000
                ? 'Tu envío va asegurado por su valor completo y requiere firma al entregar.'
                : total >= 20000
                  ? 'Tu envío requiere firma al entregar.'
                  : '';
              const tierEn = total >= 100000
                ? 'Your shipment is fully insured and requires a signature on delivery.'
                : total >= 20000
                  ? 'Your shipment requires a signature on delivery.'
                  : '';
              const nextEs = ord.method === 'pickup'
                ? 'Elegiste recogida local gratuita: te escribiremos a este correo para coordinar el encuentro en un punto público de Miami.'
                : `Te avisaremos cuando tu orden salga. Entrega estimada: 3–7 días laborables. ${tierEs}`.trim();
              const nextEn = ord.method === 'pickup'
                ? 'You chose free local pickup: we will email you to arrange the meeting at a public location in Miami.'
                : `We will let you know when your order ships. Estimated delivery: 3–7 business days. ${tierEn}`.trim();
              const text =
`Hola ${first ? first + ', ' : ''}¡gracias por tu compra en Señor Rey Marketplace!

Tu orden ${num} está confirmada.

${itemLines}
Total: ${money(total)}

${nextEs}

Guarda tu número de orden: cuando recibas tu compra, puedes dejar tu reseña en la página del artículo usando este número y tu correo.

¿Preguntas? Escríbenos a ventas@senorrey.com

— Señor Rey Marketplace
https://senorrey.com/

———— English ————
Hi ${first ? first + ', ' : ''}thank you for your purchase at Señor Rey Marketplace!
Your order ${num} is confirmed. Total: ${money(total)}.
${nextEn}
Questions? Email us at ventas@senorrey.com`;
              const html =
`<div style="font-family:Georgia,serif;background:#0d0b09;color:#e8ddc9;padding:28px;border-radius:10px;max-width:560px">
  <div style="text-align:center;font-size:22px;letter-spacing:2px;color:#c9a24d">SEÑOR REY MARKETPLACE</div>
  <p style="text-align:center;color:#9c8f78;margin:6px 0 20px">Confirmación de orden · Order confirmation</p>
  <p>Hola ${first ? esc(first) + ', ' : ''}¡gracias por tu compra! Tu orden está confirmada.</p>
  <p style="font-size:20px;color:#c9a24d">Orden ${esc(num)}</p>
  <ul style="padding-left:18px">${itemRows}</ul>
  <p><strong>Total: ${money(total)}</strong></p>
  <p>${esc(nextEs)}</p>
  <p>Guarda tu número de orden: cuando recibas tu compra, puedes dejar tu reseña en la página del artículo usando este número y tu correo.</p>
  <p>¿Preguntas? <a href="mailto:ventas@senorrey.com" style="color:#c9a24d">ventas@senorrey.com</a></p>
  <hr style="border:none;border-top:1px solid #3a332a;margin:20px 0">
  <p style="color:#9c8f78">Hi ${first ? esc(first) + ', ' : ''}thank you for your purchase! Your order ${esc(num)} is confirmed. ${esc(nextEn)} Questions? Email us at ventas@senorrey.com</p>
</div>`;
              const resp = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  from: 'Señor Rey Marketplace <ventas@senorrey.com>',
                  to: [cd.email],
                  reply_to: 'ventas@senorrey.com',
                  subject: `Confirmación de tu orden ${num} — Señor Rey Marketplace`,
                  text,
                  html,
                }),
              });
              if (resp.ok) {
                await admin.from('store_orders')
                  .update({ email_confirm_at: new Date().toISOString() })
                  .eq('session_id', session.id);
              }
            }
          } catch { /* el respaldo de 30 min lo envía; la orden ya está guardada */ }
        }
      }
    }
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
