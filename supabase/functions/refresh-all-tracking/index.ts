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

  // ─── Smart coordinate resolution ─────────────────────────────
  const eta = summary.pod?.date ?? null;
  let lat: number | null = null;
  let lng: number | null = null;

  if (status === "delivered" && podLoc) {
    lat = podLoc.lat;
    lng = podLoc.lng;
  } else if (status === "pending" && polLoc) {
    lat = polLoc.lat;
    lng = polLoc.lng;
  } else if (status === "transshipment" && latestLoc) {
    lat = latestLoc.lat;
    lng = latestLoc.lng;
  } else if (status === "moving" || status === "delayed") {
    // Interpolate between last departure and destination
    const departureEvent = events.find((e: Record<string, unknown>) =>
      e.actual === true && (e.status_code === "DEP" || (e.status as string)?.includes("Depart"))
    ) ?? events.find((e: Record<string, unknown>) => e.actual === true);

    const departureLoc = departureEvent ? loc((departureEvent as Record<string, unknown>).location as number) : polLoc;
    const arrivalLoc = podLoc;

    if (departureLoc && arrivalLoc && (departureEvent as Record<string, unknown>)?.date && eta) {
      const depDate = new Date((departureEvent as Record<string, unknown>).date as string).getTime();
      const etaDate = new Date(eta).getTime();
      const now = Date.now();
      const totalMs = etaDate - depDate;
      const elapsedMs = now - depDate;

      if (totalMs > 0) {
        const progress = Math.max(0.02, Math.min(0.98, elapsedMs / totalMs));
        const toRad = (deg: number) => (deg * Math.PI) / 180;
        const toDeg = (rad: number) => (rad * 180) / Math.PI;
        const lat1 = toRad(departureLoc.lat);
        const lng1 = toRad(departureLoc.lng);
        const lat2 = toRad(arrivalLoc.lat);
        const lng2 = toRad(arrivalLoc.lng);
        const d2 = 2 * Math.asin(Math.sqrt(
          Math.pow(Math.sin((lat2 - lat1) / 2), 2) +
          Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin((lng2 - lng1) / 2), 2)
        ));
        if (d2 > 0.001) {
          const a = Math.sin((1 - progress) * d2) / Math.sin(d2);
          const b = Math.sin(progress * d2) / Math.sin(d2);
          const x = a * Math.cos(lat1) * Math.cos(lng1) + b * Math.cos(lat2) * Math.cos(lng2);
          const y = a * Math.cos(lat1) * Math.sin(lng1) + b * Math.cos(lat2) * Math.sin(lng2);
          const z = a * Math.sin(lat1) + b * Math.sin(lat2);
          lat = Number(toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))).toFixed(4));
          lng = Number(toDeg(Math.atan2(y, x)).toFixed(4));
        } else {
          lat = departureLoc.lat;
          lng = departureLoc.lng;
        }
      } else {
        lat = departureLoc?.lat ?? latestLoc?.lat ?? null;
        lng = departureLoc?.lng ?? latestLoc?.lng ?? null;
      }
    } else {
      lat = latestLoc?.lat ?? null;
      lng = latestLoc?.lng ?? null;
    }
  } else {
    lat = latestLoc?.lat ?? null;
    lng = latestLoc?.lng ?? null;
  }

  return {
    status,
    lat,
    lng,
    eta,
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
        // Guard: check for recent duplicate notification to prevent double-firing
        if (statusChanged || etaChanged) {
          const notifType = statusChanged
            ? data.status === "delayed" ? "delay" : data.status === "delivered" ? "arrival" : "status_change"
            : "eta_change";

          // Check if a notification of this type was already created in the last 10 minutes
          const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          const { data: existing } = await supabase
            .from("shipping_notifications")
            .select("id")
            .eq("shipment_id", s.id)
            .eq("type", notifType)
            .gte("created_at", tenMinAgo)
            .limit(1);

          if (existing && existing.length > 0) {
            console.log(`Skipping duplicate ${notifType} notification for ${s.container_number}`);
          } else {
            let type = notifType;
            let title = "";
            let message = "";

            // Use the DB destination (what user expects) rather than API's POD
            const dest = s.destination || data.destination || "destination";

            if (statusChanged && data.status === "delayed") {
              title = `${s.container_number} — Delay Alert`;
              message = `Status changed from ${formatStatus(s.status)} to delayed. ${
                data.eta ? "New ETA: " + formatDate(data.eta) : "ETA pending."
              }`;
            } else if (statusChanged && data.status === "delivered") {
              title = `${s.container_number} — Delivered`;
              message = `Container has arrived at ${dest}.`;
            } else if (statusChanged) {
              title = `${s.container_number} — Status Update`;
              message = `Status changed from ${formatStatus(s.status)} to ${formatStatus(
                data.status!
              )}.`;
            } else if (etaChanged) {
              title = `${s.container_number} — ETA Delayed`;
              const oldEta = s.eta ? formatDate(s.eta) : "TBC";
              const newEta = formatDate(data.eta!);
              message = `Arrival pushed back to ${newEta} (was ${oldEta}).`;
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
