-- ============================================================
--  TeaTrade Shipping — Database Migration
--  Safe to run on existing projects: uses prefixed table name
--  in the public schema. No new schemas required.
-- ============================================================

-- 1. Create the shipments table (prefixed to avoid conflicts)
CREATE TABLE IF NOT EXISTS public.shipping_shipments (
    id               uuid            DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id          uuid            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    container_number text            NOT NULL,
    status           text            NOT NULL DEFAULT 'pending'
                                     CHECK (status IN ('pending','moving','transshipment','delayed','delivered')),
    origin           text,
    destination      text,
    lat              double precision,
    lng              double precision,
    eta              timestamptz,
    route_name       text,
    days_transit     integer,
    created_at       timestamptz     DEFAULT now() NOT NULL,
    updated_at       timestamptz
);

-- 2. Index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_shipping_shipments_user_id
    ON public.shipping_shipments (user_id);

-- 3. Auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION public.shipping_set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shipping_shipments_updated_at ON public.shipping_shipments;
CREATE TRIGGER shipping_shipments_updated_at
    BEFORE UPDATE ON public.shipping_shipments
    FOR EACH ROW
    EXECUTE FUNCTION public.shipping_set_updated_at();

-- 4. Enable Row Level Security
ALTER TABLE public.shipping_shipments ENABLE ROW LEVEL SECURITY;

-- 5. Policies: users can only see/insert/update/delete their own rows
DROP POLICY IF EXISTS "shipping_select_own" ON public.shipping_shipments;
CREATE POLICY "shipping_select_own"
    ON public.shipping_shipments
    FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "shipping_insert_own" ON public.shipping_shipments;
CREATE POLICY "shipping_insert_own"
    ON public.shipping_shipments
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "shipping_update_own" ON public.shipping_shipments;
CREATE POLICY "shipping_update_own"
    ON public.shipping_shipments
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "shipping_delete_own" ON public.shipping_shipments;
CREATE POLICY "shipping_delete_own"
    ON public.shipping_shipments
    FOR DELETE
    USING (auth.uid() = user_id);

-- 6. Admin (service_role) can do everything — for your manual updates
DROP POLICY IF EXISTS "shipping_service_role_all" ON public.shipping_shipments;
CREATE POLICY "shipping_service_role_all"
    ON public.shipping_shipments
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 7. Grant table permissions to the API roles
GRANT ALL ON public.shipping_shipments TO authenticated;
GRANT SELECT ON public.shipping_shipments TO anon;
GRANT ALL ON public.shipping_shipments TO service_role;

-- Done! No extra settings needed — this table is in the public schema
-- and will appear automatically in the Supabase Table Editor.

-- ============================================================
--  NOTIFICATIONS TABLE & AUTO-TRIGGER
-- ============================================================

-- 8. Notifications table
CREATE TABLE IF NOT EXISTS public.shipping_notifications (
    id               uuid            DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id          uuid            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    shipment_id      uuid            REFERENCES public.shipping_shipments(id) ON DELETE CASCADE,
    type             text            NOT NULL DEFAULT 'info'
                                     CHECK (type IN ('status_change','eta_change','delay','arrival','info','new_tracking')),
    title            text            NOT NULL,
    message          text            NOT NULL,
    read             boolean         NOT NULL DEFAULT false,
    created_at       timestamptz     DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shipping_notifications_user_id
    ON public.shipping_notifications (user_id);

ALTER TABLE public.shipping_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notif_select_own" ON public.shipping_notifications;
CREATE POLICY "notif_select_own"
    ON public.shipping_notifications FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "notif_update_own" ON public.shipping_notifications;
CREATE POLICY "notif_update_own"
    ON public.shipping_notifications FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "notif_insert_service" ON public.shipping_notifications;
CREATE POLICY "notif_insert_service"
    ON public.shipping_notifications FOR INSERT
    TO service_role
    WITH CHECK (true);

DROP POLICY IF EXISTS "notif_all_service" ON public.shipping_notifications;
CREATE POLICY "notif_all_service"
    ON public.shipping_notifications FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

GRANT ALL ON public.shipping_notifications TO authenticated;
GRANT ALL ON public.shipping_notifications TO service_role;

-- 9. Trigger: auto-create notification when shipment status or ETA changes
CREATE OR REPLACE FUNCTION public.shipping_notify_on_change()
RETURNS trigger AS $$
DECLARE
    notif_type text;
    notif_title text;
    notif_msg text;
    eta_formatted text;
BEGIN
    -- Status change
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        notif_type := 'status_change';
        notif_title := NEW.container_number || ' — Status Update';
        notif_msg := 'Status changed from ' || COALESCE(OLD.status, 'unknown')
                     || ' to ' || NEW.status;

        IF NEW.status = 'delayed' THEN
            notif_type := 'delay';
            notif_title := NEW.container_number || ' — Delay Alert';
        END IF;

        IF NEW.status = 'delivered' THEN
            notif_type := 'arrival';
            notif_title := NEW.container_number || ' — Delivered';
            notif_msg := 'Container has arrived at ' || COALESCE(NEW.destination, 'destination');
        END IF;

        INSERT INTO public.shipping_notifications (user_id, shipment_id, type, title, message)
        VALUES (NEW.user_id, NEW.id, notif_type, notif_title, notif_msg);
    END IF;

    -- ETA change
    IF OLD.eta IS DISTINCT FROM NEW.eta AND NEW.eta IS NOT NULL THEN
        eta_formatted := to_char(NEW.eta AT TIME ZONE 'UTC', 'DD/MM/YYYY');
        notif_type := 'eta_change';
        notif_title := NEW.container_number || ' — ETA Updated';
        notif_msg := 'Estimated arrival updated to ' || eta_formatted;

        IF OLD.eta IS NOT NULL AND NEW.eta > OLD.eta THEN
            notif_type := 'delay';
            notif_title := NEW.container_number || ' — ETA Delayed';
            notif_msg := 'Arrival pushed back to ' || eta_formatted
                         || ' (was ' || to_char(OLD.eta AT TIME ZONE 'UTC', 'DD/MM/YYYY') || ')';
        END IF;

        INSERT INTO public.shipping_notifications (user_id, shipment_id, type, title, message)
        VALUES (NEW.user_id, NEW.id, notif_type, notif_title, notif_msg);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS shipping_notify_trigger ON public.shipping_shipments;
CREATE TRIGGER shipping_notify_trigger
    AFTER UPDATE ON public.shipping_shipments
    FOR EACH ROW
    EXECUTE FUNCTION public.shipping_notify_on_change();

-- 10a. Notify admin when a new shipment is added
CREATE OR REPLACE FUNCTION public.shipping_notify_new_tracking()
RETURNS trigger AS $$
BEGIN
    INSERT INTO public.shipping_notifications (user_id, shipment_id, type, title, message)
    VALUES (
        NEW.user_id,
        NEW.id,
        'new_tracking',
        NEW.container_number || ' — New Tracking Request',
        'New container tracking request for ' || NEW.container_number || '.'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS shipping_notify_new_tracking_trigger ON public.shipping_shipments;
CREATE TRIGGER shipping_notify_new_tracking_trigger
    AFTER INSERT ON public.shipping_shipments
    FOR EACH ROW
    EXECUTE FUNCTION public.shipping_notify_new_tracking();

-- 10b. Enable Realtime on the notifications table
--     (safe to re-run — ignores if already added)
ALTER PUBLICATION supabase_realtime ADD TABLE public.shipping_notifications;
