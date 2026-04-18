/**
 * Supabase Edge Function: send-shipping-notification
 * Sends branded email notifications for shipping status/ETA changes via Resend.
 *
 * Deploy:
 *   supabase functions deploy send-shipping-notification --no-verify-jwt
 *
 * Environment variables (set via Supabase dashboard → Edge Functions → Secrets):
 *   RESEND_API_KEY   — your Resend API key
 *   FROM_EMAIL       — e.g. "TeaTrade Shipping <shipping@teatrade.co.uk>"
 *
 * This function is designed to be called by a Supabase Database Webhook
 * that fires on INSERT into public.shipping_notifications.
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "TeaTrade Shipping <contact@teatrade.co.uk>";
const ADMIN_EMAIL = "contact@teatrade.co.uk";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  try {
    const payload = await req.json();

    // Support both direct calls and database webhook payloads
    const record = payload.record || payload;

    const { user_id, type, title, message, shipment_id } = record;

    if (!user_id || !title || !message) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Look up user email via service role
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(user_id);

    if (userError || !userData?.user?.email) {
      console.error("Could not fetch user email:", userError);
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const userEmail = userData.user.email;

    // Fetch shipment details if available
    let shipment = null;
    if (shipment_id) {
      const { data } = await supabase
        .from("shipping_shipments")
        .select("*")
        .eq("id", shipment_id)
        .single();
      shipment = data;
    }

    // Build branded email HTML
    const emailHTML = buildEmailHTML({ type, title, message, shipment, userEmail });

    // Send via Resend
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: type === "new_tracking" ? [ADMIN_EMAIL] : [userEmail],
        subject: `TeaTrade Shipping — ${title}`,
        html: emailHTML,
      }),
    });

    const resendData = await resendRes.json();

    if (!resendRes.ok) {
      console.error("Resend error:", resendData);
      return new Response(JSON.stringify({ error: "Email send failed", details: resendData }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true, id: resendData.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

/* ── Email Template ──────────────────────────────────────────────── */

interface EmailData {
  type: string;
  title: string;
  message: string;
  shipment: any | null;
  userEmail: string;
}

function esc(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function typeColor(type: string): { bg: string; fg: string; label: string } {
  switch (type) {
    case "delay":         return { bg: "#fce8e6", fg: "#c5221f", label: "Delay Alert" };
    case "arrival":       return { bg: "#e6f4ea", fg: "#137333", label: "Delivered" };
    case "eta_change":    return { bg: "#fef7e0", fg: "#b06000", label: "ETA Updated" };
    case "status_change": return { bg: "#e8f0fe", fg: "#1a73e8", label: "Status Update" };
    case "new_tracking":  return { bg: "#e0f2f1", fg: "#00695c", label: "New Tracking Request" };
    default:              return { bg: "#f1f3f4", fg: "#5f6368", label: "Notification" };
  }
}

function buildEmailHTML({ type, title, message, shipment, userEmail }: EmailData): string {
  const tc = typeColor(type);
  const eta = shipment?.eta
    ? new Date(shipment.eta).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;

  const shipmentBlock = shipment
    ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr><td style="background:#f8f9fa;border:1px solid #ebebeb;border-radius:8px;padding:16px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:12px;color:#5f6368;text-transform:uppercase;letter-spacing:0.8px;font-weight:600;padding-bottom:8px;">Shipment Details</td>
          </tr>
          ${type === "new_tracking" ? `<tr><td style="font-size:14px;color:#3c4043;padding-bottom:8px;">Submitted by: <strong>${esc(userEmail)}</strong></td></tr>` : ""}
          <tr>
            <td style="font-size:15px;font-weight:700;color:#202124;font-family:'Courier New',monospace;padding-bottom:6px;">${esc(shipment.container_number)}</td>
          </tr>
          ${shipment.origin || shipment.destination ? `<tr><td style="font-size:14px;color:#3c4043;padding-bottom:4px;">${esc(shipment.origin || "—")} → ${esc(shipment.destination || "—")}</td></tr>` : ""}
          ${eta ? `<tr><td style="font-size:14px;color:#3c4043;">ETA: <strong>${eta}</strong></td></tr>` : ""}
          ${shipment.status ? `<tr><td style="padding-top:8px;"><span style="display:inline-block;background:${tc.bg};color:${tc.fg};padding:4px 14px;border-radius:50px;font-size:12px;font-weight:600;text-transform:capitalize;">${esc(shipment.status)}</span></td></tr>` : ""}
        </table>
      </td></tr>
    </table>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;">
<tr><td align="center" style="padding:32px 16px;">

<!-- Container -->
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

<!-- Header -->
<tr>
<td style="background:#ffffff;padding:28px 32px 20px;border-bottom:1px solid #ebebeb;text-align:center;">
    <div style="font-size:28px;font-weight:500;color:#5f6368;letter-spacing:-0.5px;font-family:Arial,sans-serif;">Tea<span style="color:#202124;font-weight:700;">Trade</span></div>
    <div style="margin-top:6px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:#1a73e8;">Shipping</div>
</td>
</tr>

<!-- Alert Badge -->
<tr>
<td style="padding:24px 32px 0;">
    <div style="display:inline-block;background:${tc.bg};color:${tc.fg};padding:6px 16px;border-radius:50px;font-size:12px;font-weight:600;letter-spacing:0.3px;">${tc.label}</div>
</td>
</tr>

<!-- Body -->
<tr>
<td style="padding:20px 32px 24px;">
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#202124;line-height:1.3;">${esc(title)}</h2>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#3c4043;">${esc(message)}</p>

    ${shipmentBlock}

    <!-- CTA Button -->
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr><td align="center" style="padding:16px 0 8px;">
        <a href="https://shipping.teatrade.co.uk" target="_blank" style="display:inline-block;background:#1a73e8;color:#ffffff;padding:14px 44px;border-radius:50px;text-decoration:none;font-weight:600;font-size:15px;letter-spacing:0.3px;box-shadow:0 2px 8px rgba(26,115,232,0.35);">
            View Dashboard
        </a>
    </td></tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 0;">
    <tr><td style="border-top:1px solid #ebebeb;"></td></tr>
    </table>

    <p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#9aa0a6;">
        This is an automated notification from TeaTrade Shipping. If you didn't request container tracking, you can safely ignore this email.
    </p>
</td>
</tr>

<!-- Footer -->
<tr>
<td style="padding:20px 32px;background:#f8f9fa;border-top:1px solid #ebebeb;text-align:center;">
    <p style="margin:0 0 6px;color:#5f6368;font-size:12px;line-height:1.5;">
        &copy; 2026 TeaTrade &middot; <a href="https://teatrade.co.uk" style="color:#1a73e8;text-decoration:none;">teatrade.co.uk</a>
    </p>
    <p style="margin:0;color:#999999;font-size:11px;line-height:1.5;">
        TeaTrade Shipping &middot; Container Tracking & Logistics
    </p>
</td>
</tr>

</table>
<!-- /Container -->

</td></tr>
</table>
</body>
</html>`;
}
