/**
 * Supabase Edge Function: track-container
 * Proxies container tracking requests to TimeToCargo API so the API key
 * is never exposed to the browser.
 *
 * Deploy:
 *   supabase functions deploy track-container --no-verify-jwt
 *
 * Secret (set via CLI or dashboard):
 *   TIMETOCARGO_API_KEY — your TimeToCargo API token
 *
 * Frontend call:
 *   POST https://<project-ref>.supabase.co/functions/v1/track-container
 *   Body: { "container_number": "MSCU7294813" }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const TIMETOCARGO_API_KEY = Deno.env.get("TIMETOCARGO_API_KEY")!;
const ALLOWED_ORIGIN = "https://shipping.teatrade.co.uk";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
};

/** Validate container number format: 4 letters + 7 digits (ISO 6346) */
function isValidContainer(num: string): boolean {
  return /^[A-Z]{4}\d{7}$/i.test(num);
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only accept POST
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await req.json();
    const containerNumber = String(body.container_number || "").trim().toUpperCase();

    if (!containerNumber || !isValidContainer(containerNumber)) {
      return new Response(
        JSON.stringify({ error: "Invalid container number. Expected format: 4 letters + 7 digits (e.g. MSCU7294813)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call TimeToCargo API (key stays server-side)
    const apiUrl = new URL("https://tracking.timetocargo.com/v1/container");
    apiUrl.searchParams.set("api_key", TIMETOCARGO_API_KEY);
    apiUrl.searchParams.set("company", "AUTO");
    apiUrl.searchParams.set("container_number", containerNumber);

    const apiRes = await fetch(apiUrl.toString(), {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error(`TimeToCargo API error ${apiRes.status}:`, errText);

      // Map known status codes to user-friendly messages
      const messages: Record<number, string> = {
        401: "Tracking API authentication failed. Contact support.",
        403: "Tracking API access denied. Contact support.",
        404: "Container not found. Check the number and try again.",
        429: "Too many tracking requests. Please wait a moment and retry.",
      };

      return new Response(
        JSON.stringify({ error: messages[apiRes.status] || "Tracking service temporarily unavailable." }),
        { status: apiRes.status >= 500 ? 502 : apiRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await apiRes.json();

    if (!data?.success || !data?.data) {
      return new Response(
        JSON.stringify({ error: data?.status_description || "Container not found or no data available." }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── Parse the TimeToCargo response ───────────────────────────
    // Structure: data.data.{ summary, locations[], terminals[], container.events[], shipment_status }
    const d = data.data;
    const locations: Array<{ id: number; name: string; country: string; lat: number; lng: number }> = d.locations ?? [];
    const events: Array<Record<string, unknown>> = d.container?.events ?? [];
    const summary = d.summary ?? {};

    // Helper: resolve a location ID to its name + coords
    const loc = (id: number | null | undefined) => locations.find((l) => l.id === id) ?? null;

    // Origin = POL location, Destination = POD location
    const polLoc = loc(summary.pol?.location);
    const podLoc = loc(summary.pod?.location);

    // Latest event = first in the array (sorted most recent first)
    const latestEvent = events[0] ?? null;
    const latestLoc = latestEvent ? loc(latestEvent.location as number) : null;

    // Map TimeToCargo shipment_status to our app's status values
    const statusMap: Record<string, string> = {
      "IN_TRANSIT": "moving",
      "TRANSSHIPMENT": "transshipment",
      "DELIVERED": "delivered",
      "PENDING": "pending",
      "DELAYED": "delayed",
    };
    const rawStatus = (d.shipment_status ?? "").toUpperCase();
    const status = statusMap[rawStatus] ?? rawStatus.toLowerCase() ?? null;

    // ETA = POD date from summary
    const eta = summary.pod?.date ?? null;

    // Coordinates = latest event's location
    const lat = latestLoc?.lat ?? null;
    const lng = latestLoc?.lng ?? null;

    // Vessel from latest event with a real vessel name
    const vesselEvent = events.find((e) => e.vessel && e.vessel !== "LADEN");
    const vessel = (vesselEvent?.vessel as string) ?? null;

    // Carrier from summary
    const carrier = summary.company?.name ?? null;

    const result = {
      container_number: containerNumber,
      status,
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
      eta,
      origin: polLoc?.name ?? null,
      destination: podLoc?.name ?? null,
      vessel,
      carrier,
      container_type: d.container?.type ?? null,
      recent_events: events.slice(0, 5).map((e) => {
        const eLoc = loc(e.location as number);
        return {
          date: e.date,
          location: eLoc?.name ?? null,
          country: eLoc?.country ?? null,
          description: e.status,
          vessel: e.vessel,
          actual: e.actual,
        };
      }),
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("track-container error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error processing tracking request." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
