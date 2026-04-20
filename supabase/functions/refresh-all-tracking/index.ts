/**
 * Supabase Edge Function: refresh-all-tracking
 * Server-side scheduled job that refreshes ALL non-delivered shipments
 * via TimeToCargo API. Runs on a cron schedule — no user session required.
 *
 * This ensures status/ETA updates and email notifications happen 24/7,
 * even when no user is logged in or has the site open.
 *
 * Deploy:
 *   supabase functions deploy refresh-all-tracking --no-verify-jwt
 *
 * Secrets required:
 *   TIMETOCARGO_API_KEY
 *   SUPABASE_URL           (auto-set by Supabase)
 *   SUPABASE_SERVICE_ROLE_KEY (auto-set by Supabase)
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TIMETOCARGO_API_KEY = Deno.env.get("TIMETOCARGO_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const REQUEST_GAP_MS = 8000; // 8s between API calls (rate limit: 8 req/min)

const STATUS_MAP: Record<string, string> = {
  IN_TRANSIT: "moving",
  TRANSSHIPMENT: "transshipment",
  DELIVERED: "delivered",
  PENDING: "pending",
  DELAYED: "delayed",
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatStatus(status: string): string {
  const map: Record<string, string> = {
    moving: "In Transit",
    transshipment: "Transshipment",
    delayed: "Delayed",
    pending: "Pending",
    delivered: "Delivered",
  };
  return map[status] || status;
}

async function fetchTrackingData(containerNumber: string) {
  const url = new URL("https://tracking.timetocargo.com/v1/container");
  url.searchParams.set("api_key", TIMETOCARGO_API_KEY);
  url.searchParams.set("company", "AUTO");
  url.searchParams.set("container_number", containerNumber);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (!json?.success || !json?.data) return null;

  const d = json.data;
  const locations: Array<{ id: number; name: string; lat: number; lng: number }> =
    d.locations ?? [];
  const events = d.container?.events ?? [];
  const summary = d.summary ?? {};

  const loc = (id: number | null | undefined) =>
    locations.find((l) => l.id === id) ?? null;

  const polLoc = loc(summary.pol?.location);
  const podLoc = loc(summary.pod?.location);
  const latestEvent = events[0] ?? null;
  const latestLoc = latestEvent ? loc(latestEvent.location as number) : null;

  const rawStatus = (d.shipment_status ?? "").toUpperCase();
  const status = STATUS_MAP[rawStatus] ?? rawStatus.toLowerCase() ?? null;

  const vesselEvent = events.find(
    (e: Record<string, unknown>) => e.vessel && e.vessel !== "LADEN"
  );

  return {
    status,
    lat: latestLoc?.lat ?? null,
    lng: latestLoc?.lng ?? null,
    eta: summary.pod?.date ?? null,
    origin: polLoc?.name ?? null,
    destination: podLoc?.name ?? null,
    vessel: (vesselEvent?.vessel as string) ?? null,
    carrier: summary.company?.name ?? null,
  };
}

serve(async (req: Request) => {
  // Allow CORS preflight (in case of manual invocation)
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Use service role to access all users' shipments
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch all non-delivered shipments across all users
  const { data: shipments, error: fetchError } = await supabase
    .from("shipping_shipments")
    .select("*")
    .not("status", "eq", "delivered")
    .order("updated_at", { ascending: true }); // oldest-updated first

  if (fetchError) {
    console.error("Failed to fetch shipments:", fetchError.message);
    return new Response(
      JSON.stringify({ error: "Failed to fetch shipments" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!shipments || shipments.length === 0) {
    return new Response(
      JSON.stringify({ message: "No active shipments to refresh", updated: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < shipments.length; i++) {
    const s = shipments[i];

    try {
      const data = await fetchTrackingData(s.container_number);
      if (!data || (!data.status && data.lat == null)) {
        // No usable data — skip
        if (i < shipments.length - 1) await sleep(REQUEST_GAP_MS);
        continue;
      }

      // Build update — only changed fields
      const updates: Record<string, unknown> = {};
      let statusChanged = false;
      let etaChanged = false;

      if (data.status && data.status !== s.status) {
        updates.status = data.status;
        statusChanged = true;
      }
      if (data.lat != null && data.lat !== s.lat) updates.lat = data.lat;
      if (data.lng != null && data.lng !== s.lng) updates.lng = data.lng;
      if (data.eta && data.eta !== s.eta) {
        updates.eta = data.eta;
        etaChanged = true;
      }
      if (data.origin && !s.origin) updates.origin = data.origin;
      if (data.destination && !s.destination) updates.destination = data.destination;
      if (data.origin && data.destination && !s.route_name) {
        updates.route_name = `${data.origin} → ${data.destination}`;
      }

      // Nothing changed — skip
      if (Object.keys(updates).length === 0) {
        if (i < shipments.length - 1) await sleep(REQUEST_GAP_MS);
        continue;
      }

      // Write update — DB trigger saves old values to shipment_history
      updates.updated_at = new Date().toISOString();
      const { error: updateError } = await supabase
        .from("shipping_shipments")
        .update(updates)
        .eq("id", s.id);

      if (updateError) {
        console.error(`Update failed for ${s.container_number}:`, updateError.message);
        errors++;
      } else {
        updated++;

        // Create notification for status/ETA changes → triggers email webhook
        if (statusChanged || etaChanged) {
          let type = "status_change";
          let title = "";
          let message = "";

          if (statusChanged && data.status === "delayed") {
            type = "delay";
            title = `${s.container_number} — Delay Detected`;
            message = `Container status changed to delayed. ${
              data.eta ? "New ETA: " + formatDate(data.eta) : "ETA pending."
            }`;
          } else if (statusChanged && data.status === "delivered") {
            type = "arrival";
            title = `${s.container_number} — Delivered`;
            message = `Container has arrived at ${data.destination || "destination"}.`;
          } else if (statusChanged) {
            type = "status_change";
            title = `${s.container_number} — Status Update`;
            message = `Status changed from ${formatStatus(s.status)} to ${formatStatus(
              data.status!
            )}.`;
          } else if (etaChanged) {
            type = "eta_change";
            title = `${s.container_number} — ETA Updated`;
            const oldEta = s.eta ? formatDate(s.eta) : "TBC";
            const newEta = formatDate(data.eta!);
            message = `ETA changed from ${oldEta} to ${newEta}.`;
          }

          await supabase.from("shipping_notifications").insert({
            user_id: s.user_id,
            shipment_id: s.id,
            type,
            title,
            message,
            read: false,
          });
        }
      }
    } catch (err) {
      console.error(`Error tracking ${s.container_number}:`, (err as Error).message);
      errors++;
    }

    // Stagger requests
    if (i < shipments.length - 1) await sleep(REQUEST_GAP_MS);
  }

  console.log(`Refresh complete: ${updated} updated, ${errors} errors, ${shipments.length} checked`);

  return new Response(
    JSON.stringify({
      message: "Refresh complete",
      checked: shipments.length,
      updated,
      errors,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
