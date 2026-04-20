/**
 * TeaTrade Shipping — Container Tracking Dashboard
 * "Wizard of Oz" strategy: No live API. Data is manually updated in Supabase.
 *
 * ──────────────────────────────────────────────────────────────────
 *  CONFIGURATION — Replace with your own Supabase credentials
 * ──────────────────────────────────────────────────────────────────
 */
const SUPABASE_URL = 'https://kidwhcpxqeighhqcbhmt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtpZHdoY3B4cWVpZ2hocWNiaG10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyODEzNTgsImV4cCI6MjA5MTg1NzM1OH0.aaXJP9WxYXW4pFudz08mfeecQak9_M56CJlXWlUVtTY';

/* ── Supabase client (renamed to avoid CDN global conflict) ──────── */
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ── DOM refs ────────────────────────────────────────────────────── */
const $ = (sel) => document.querySelector(sel);
const authOverlay    = $('#authOverlay');
const authForm       = $('#authForm');
const authEmail      = $('#authEmail');
const authPassword   = $('#authPassword');
const authError      = $('#authError');
const authTitle      = $('#authTitle');
const authSubmitBtn  = $('#authSubmitBtn');
const authSwitchText = $('#authSwitchText');
const authSwitchLink = $('#authSwitchLink');
const appLayout      = $('#appLayout');
const containerInput = $('#containerInput');
const containerCount = $('#containerCount');
const trackBtn       = $('#trackBtn');
const shipmentList   = $('#shipmentList');
const emptyState     = $('#emptyState');
const detailPanel    = $('#detailPanel');
const toastEl        = $('#toast');
const toastMessage   = $('#toastMessage');

/* ── State ───────────────────────────────────────────────────────── */
let currentUser    = null;
let shipments      = [];
let map            = null;
let markers        = {};      // keyed by shipment id
let transitChart   = null;
let isSignUp       = false;

/* ══════════════════════════════════════════════════════════════════
   AUTH
   ══════════════════════════════════════════════════════════════════ */

function toggleAuthMode() {
    isSignUp = !isSignUp;
    authTitle.textContent     = isSignUp ? 'Create an account' : 'Sign in to track shipments';
    authSubmitBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
    authSwitchText.textContent = isSignUp ? 'Already have an account?' : 'No account?';
    authSwitchLink.textContent = isSignUp ? 'Sign in' : 'Create one';
    authError.textContent = '';
    // Hide forgot link when in sign-up mode
    const forgotWrap = $('#authForgotWrap');
    if (forgotWrap) forgotWrap.style.display = isSignUp ? 'none' : '';
}

function showForgotPassword() {
    $('#authOverlay').classList.add('hidden');
    const overlay = $('#resetOverlay');
    overlay.classList.remove('hidden');
    // Ensure we show the email form, not the password form
    $('#resetEmailForm').style.display = '';
    $('#resetPasswordForm').style.display = 'none';
    $('#resetTitle').textContent = 'Reset your password';
    $('#resetDesc').textContent = "Enter your email and we'll send you a reset link.";
    $('#resetError').textContent = '';
    $('#resetPwError').textContent = '';
}

// Send password reset email
$('#resetEmailForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#resetEmail').value.trim();
    if (!email) return;

    const btn = $('#resetEmailBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    $('#resetError').textContent = '';

    const { error } = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: 'https://shipping.teatrade.co.uk/'
    });

    btn.disabled = false;
    btn.textContent = 'Send Reset Link';

    if (error) {
        $('#resetError').textContent = error.message;
    } else {
        $('#resetError').style.color = 'var(--tt-green-dark)';
        $('#resetError').textContent = 'Check your inbox for the reset link.';
        btn.textContent = 'Email Sent';
        btn.disabled = true;
    }
});

// Set new password
$('#resetPasswordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#newPassword').value;
    const confirm = $('#confirmPassword').value;
    const errEl = $('#resetPwError');

    if (pw !== confirm) {
        errEl.textContent = 'Passwords do not match.';
        return;
    }

    const btn = $('#resetPwBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    errEl.textContent = '';

    const { error } = await sb.auth.updateUser({ password: pw });

    btn.disabled = false;
    btn.textContent = 'Update Password';

    if (error) {
        errEl.textContent = error.message;
    } else {
        errEl.style.color = 'var(--tt-green-dark)';
        errEl.textContent = 'Password updated! Redirecting...';
        setTimeout(() => {
            $('#resetOverlay').classList.add('hidden');
        }, 1500);
    }
});

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email    = authEmail.value.trim();
    const password = authPassword.value;

    if (!email || !password) {
        authError.textContent = 'Please fill in all fields.';
        return;
    }

    authSubmitBtn.disabled = true;
    authSubmitBtn.innerHTML = '<span class="spinner"></span>';
    authError.textContent = '';

    try {
        let result;
        if (isSignUp) {
            result = await sb.auth.signUp({ email, password });
        } else {
            result = await sb.auth.signInWithPassword({ email, password });
        }

        if (result.error) {
            authError.textContent = result.error.message;
            return;
        }

        if (isSignUp && result.data?.user && !result.data.session) {
            authError.style.color = 'var(--tt-green-dark)';
            authError.textContent = 'Check your email to confirm your account.';
            return;
        }

        // Success — hide the auth overlay
        const authOverlay = $('#authOverlay');
        if (authOverlay) authOverlay.classList.add('hidden');
    } catch (err) {
        authError.textContent = 'An unexpected error occurred. Please try again.';
    } finally {
        authSubmitBtn.disabled = false;
        authSubmitBtn.textContent = isSignUp ? 'Create Account' : 'Sign In';
    }
});

async function signOut() {
    stopAutoRefresh();
    if (notifChannel) { sb.removeChannel(notifChannel); notifChannel = null; }
    await sb.auth.signOut();
    currentUser = null;
    shipments   = [];
    notifications = [];
    renderShipmentList();
    renderNotifications();
    plotShipments();
    updateAuthUI();
    loadDemoData();
}

function updateAuthUI() {
    const loggedIn = !!currentUser;
    const loggedOutEl = $('#loggedOutActions');
    const loggedInEl  = $('#loggedInActions');
    if (loggedOutEl) loggedOutEl.style.display = loggedIn ? 'none' : 'flex';
    if (loggedInEl)  loggedInEl.style.display  = loggedIn ? 'flex' : 'none';
    if (loggedIn) {
        const menuBtn = $('#userMenuBtn');
        if (menuBtn) menuBtn.style.display = 'inline-flex';
    }
    // When not logged in, show prompt on tracking button
    if (!loggedIn) {
        trackBtn.disabled = false;
    }
}

async function onUserLoggedIn(user) {
    clearDemoData();
    currentUser = user;
    updateAuthUI();
    initMap();
    initChart();
    await loadShipments();
    loadNotifications();
    subscribeToNotifications();
    // Start live tracking: immediate background refresh + periodic polling
    refreshAllShipments();
    startAutoRefresh();
}

/* Listen for auth state changes */
sb.auth.onAuthStateChange((_event, session) => {
    if (_event === 'PASSWORD_RECOVERY') {
        // User clicked reset link in email — show the new password form
        const overlay = $('#resetOverlay');
        overlay.classList.remove('hidden');
        $('#authOverlay').classList.add('hidden');
        $('#resetEmailForm').style.display = 'none';
        $('#resetPasswordForm').style.display = '';
        $('#resetTitle').textContent = 'Set a new password';
        $('#resetDesc').textContent = 'Enter your new password below.';
        return;
    }
    if (session?.user) {
        onUserLoggedIn(session.user);
    } else {
        currentUser = null;
        updateAuthUI();
        loadDemoData();
    }
});

/* Initialise app — always show dashboard */
(async () => {
    // Show map & chart immediately for all visitors
    initMap();
    initChart();
    updateChart();
    updateAnalytics();

    // Check if user is already logged in
    const { data: { session } } = await sb.auth.getSession();
    if (session?.user) {
        onUserLoggedIn(session.user);
    } else {
        updateAuthUI();
        loadDemoData();
    }
})();

/* ══════════════════════════════════════════════════════════════════
   MAP (Leaflet / OpenStreetMap)
   ══════════════════════════════════════════════════════════════════ */

function initMap() {
    if (map) return; // already initialised

    map = L.map('shipment-map', {
        center: [20, 40],
        zoom: 3,
        zoomControl: true,
        attributionControl: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: 'abcd'
    }).addTo(map);

    // Force a resize after layout paint
    setTimeout(() => map.invalidateSize(), 200);
}

const STATUS_COLORS = {
    moving:         '#34a853',
    transshipment:  '#f9ab00',
    delayed:        '#ea4335',
    pending:        '#bdc1c6',
    delivered:      '#1a73e8'
};

function createMarkerIcon(status) {
    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
    return L.divIcon({
        className: '',
        html: `<div class="shipping-marker ${status}" style="width:22px;height:22px;background:${color};"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -14]
    });
}

function plotShipments() {
    if (!map) return;

    // Remove stale markers
    Object.keys(markers).forEach((id) => {
        if (!shipments.find((s) => String(s.id) === id)) {
            map.removeLayer(markers[id]);
            delete markers[id];
        }
    });

    shipments.forEach((s) => {
        if (s.lat == null || s.lng == null) return;

        const id = String(s.id);

        if (markers[id]) {
            markers[id].setLatLng([s.lat, s.lng]);
            markers[id].setIcon(createMarkerIcon(s.status));
        } else {
            const marker = L.marker([s.lat, s.lng], { icon: createMarkerIcon(s.status) });
            marker.bindPopup(() => buildPopupHTML(s), { closeButton: false, maxWidth: 240 });
            marker.on('click', () => { if (isMobile()) closeMobileLeftPanel(); openDetailPanel(s); });
            marker.addTo(map);
            markers[id] = marker;
        }
    });

    // Fit bounds if we have markers (cap zoom so single-point doesn't over-zoom)
    const plotted = shipments.filter((s) => s.lat != null && s.lng != null);
    if (plotted.length) {
        const bounds = L.latLngBounds(plotted.map((s) => [s.lat, s.lng]));
        map.fitBounds(bounds.pad(0.3), { maxZoom: 5 });
    }
}

function buildPopupHTML(s) {
    const route = (s.origin && s.destination) ? `${s.origin} → ${s.destination}` : 'Route pending';
    return `
        <div class="popup-inner">
            <div class="popup-container-num">${escapeHTML(s.container_number)}</div>
            <div class="popup-route">${escapeHTML(route)}</div>
            <span class="popup-status ${s.status}">${s.status}</span>
            <button class="popup-view-btn" onclick="window.shippingApp.openDetailPanel(window.shippingApp.getShipmentById('${s.id}'), true)">View Details</button>
        </div>`;
}

/* ══════════════════════════════════════════════════════════════════
   CONTAINER INPUT & TRACKING SUBMISSION
   ══════════════════════════════════════════════════════════════════ */

containerInput.addEventListener('input', () => {
    const lines = parseContainerLines();
    const count = lines.length;
    containerCount.textContent = `${count} container${count !== 1 ? 's' : ''}`;
    trackBtn.disabled = count === 0;
});

function parseContainerLines() {
    return containerInput.value
        .split(/[\n,]+/)
        .map((l) => l.trim().toUpperCase())
        .filter((l) => l.length > 0);
}

trackBtn.addEventListener('click', async () => {
    const lines = parseContainerLines();
    if (!lines.length) return;

    // If not logged in, show the auth modal
    if (!currentUser) {
        const authOverlay = $('#authOverlay');
        if (authOverlay) authOverlay.classList.remove('hidden');
        return;
    }

    // Check for duplicates against existing shipments
    const duplicates = lines.filter((num) =>
        shipments.some((s) => s.container_number === num)
    );
    const newContainers = lines.filter((num) =>
        !shipments.some((s) => s.container_number === num)
    );

    if (duplicates.length > 0) {
        // Show confirmation modal for duplicates
        const dupShipments = duplicates.map((num) => {
            const existing = shipments.find((s) => s.container_number === num);
            const eta = existing && existing.eta
                ? new Date(existing.eta).toLocaleDateString('en-GB')
                : 'TBC';
            const status = existing ? existing.status : 'pending';
            return { num, eta, status, id: existing?.id };
        });

        const msg = dupShipments.map((d) =>
            `<strong>${d.num}</strong> — ${d.status}, ETA: ${d.eta}`
        ).join('<br>');

        const dupModal   = $('#duplicateModal');
        const dupMessage = $('#duplicateMessage');
        const dupReplace = $('#duplicateReplace');
        const dupCancel  = $('#duplicateCancel');

        dupMessage.innerHTML = (duplicates.length === 1
            ? 'This container is already being tracked:<br><br>'
            : 'These containers are already being tracked:<br><br>')
            + msg + '<br><br>Would you like to replace ' +
            (duplicates.length === 1 ? 'it' : 'them') + '?';

        dupModal.classList.remove('hidden');

        // Wait for user action
        const userChoice = await new Promise((resolve) => {
            function onReplace() { cleanup(); resolve('replace'); }
            function onCancel()  { cleanup(); resolve('cancel'); }
            function cleanup() {
                dupReplace.removeEventListener('click', onReplace);
                dupCancel.removeEventListener('click', onCancel);
                dupModal.classList.add('hidden');
            }
            dupReplace.addEventListener('click', onReplace);
            dupCancel.addEventListener('click', onCancel);
        });

        if (userChoice === 'cancel') {
            // Only submit new (non-duplicate) containers
            if (newContainers.length === 0) return;
            return await submitContainers(newContainers);
        }

        // User chose replace: delete old duplicates, then insert all
        const idsToDelete = dupShipments.map((d) => d.id).filter(Boolean);
        if (idsToDelete.length) {
            const { error: delError } = await sb
                .from('shipping_shipments')
                .delete()
                .in('id', idsToDelete)
                .eq('user_id', currentUser.id);
            if (delError) {
                showToast('Failed to remove old entries. ' + delError.message, true);
                return;
            }
            // Remove from local state so re-render is clean
            shipments = shipments.filter((s) => !idsToDelete.includes(s.id));
        }
        return await submitContainers(lines);
    }

    // No duplicates — submit straight away
    await submitContainers(lines);
});

async function submitContainers(containers) {
    if (!containers.length || !currentUser) return;

    trackBtn.disabled = true;
    trackBtn.innerHTML = '<span class="spinner"></span> Processing…';

    try {
        const rows = containers.map((container_number) => ({
            user_id: currentUser.id,
            container_number,
            status: 'pending',
            origin: null,
            destination: null,
            lat: null,
            lng: null,
            eta: null,
            route_name: null,
            days_transit: null
        }));

        const { error } = await sb.from('shipping_shipments').insert(rows);

        if (error) {
            showToast('Failed to save containers. ' + error.message, true);
            return;
        }

        containerInput.value = '';
        containerCount.textContent = '0 containers';
        showToast('Containers received. Fetching live tracking data…');
        await loadShipments();
        // Fetch live data for newly submitted containers in the background
        refreshAllShipments();
    } catch (err) {
        showToast('Network error. Please try again.', true);
    } finally {
        trackBtn.disabled = false;
        trackBtn.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
            Initialize Tracking`;
    }
}

/* ══════════════════════════════════════════════════════════════════
   LOAD & RENDER SHIPMENTS
   ══════════════════════════════════════════════════════════════════ */

async function loadShipments() {
    if (!currentUser) return;

    try {
        const { data, error } = await sb
            .from('shipping_shipments')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error loading shipments:', error.message);
            return;
        }

        shipments = data || [];
        renderShipmentList();
        plotShipments();
        updateChart();
        updateAnalytics();
    } catch (err) {
        console.error('Network error loading shipments:', err);
    }
}

function renderShipmentList() {
    if (!shipments.length) {
        emptyState.style.display = '';
        shipmentList.querySelectorAll('.shipment-card').forEach((el) => el.remove());
        return;
    }

    emptyState.style.display = 'none';

    // Remove existing cards
    shipmentList.querySelectorAll('.shipment-card').forEach((el) => el.remove());

    shipments.forEach((s) => {
        const card = document.createElement('div');
        card.className = 'shipment-card';
        card.dataset.id = s.id;

        const route = (s.origin && s.destination) ? `${s.origin} → ${s.destination}` : 'Route pending';
        const etaLabel = s.eta ? formatDate(s.eta) : '—';
        const daysLabel = s.days_transit != null ? `${s.days_transit}d` : '—';

        card.innerHTML = `
            <div class="shipment-status-dot ${s.status}"></div>
            <div class="shipment-info">
                <div class="shipment-container-num">${escapeHTML(s.container_number)}</div>
                <div class="shipment-route">${escapeHTML(route)}</div>
            </div>
            <div class="shipment-eta">
                <span>${daysLabel}</span>
                ETA ${etaLabel}
            </div>`;

        card.addEventListener('click', () => {
            if (isMobile()) closeMobileLeftPanel();
            openDetailPanel(s);
            // Pan map to marker
            if (s.lat != null && s.lng != null && map) {
                map.setView([s.lat, s.lng], 6, { animate: true });
                const marker = markers[String(s.id)];
                if (marker) marker.openPopup();
            }
        });

        shipmentList.appendChild(card);
    });
}

/* ══════════════════════════════════════════════════════════════════
   DETAIL PANEL
   ══════════════════════════════════════════════════════════════════ */

function openDetailPanel(s, scrollToAnalytics) {
    if (!s) return;
    currentDetailShipmentId = s.id;

    // Highlight card
    document.querySelectorAll('.shipment-card').forEach((c) => c.classList.remove('active'));
    const activeCard = document.querySelector(`.shipment-card[data-id="${s.id}"]`);
    if (activeCard) activeCard.classList.add('active');

    $('#detailContainerNum').textContent = s.container_number;

    const badge = $('#detailStatusBadge');
    badge.className = `detail-status-badge ${s.status}`;
    badge.querySelector('span').textContent = formatStatus(s.status);

    $('#detailOrigin').textContent      = s.origin || '—';
    $('#detailDestination').textContent  = s.destination || '—';
    $('#detailTransitDays').textContent  = s.days_transit != null ? `${s.days_transit} days` : '—';
    $('#detailEta').textContent          = s.eta ? formatDate(s.eta) : '—';
    $('#detailCoords').textContent       = (s.lat != null && s.lng != null) ? `${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}` : '—';
    $('#detailUpdated').textContent      = s.updated_at ? timeAgo(s.updated_at) : '—';

    // Progress bar
    const progressPct = computeProgress(s);
    $('#progressOriginLabel').textContent = s.origin || 'Origin';
    $('#progressDestLabel').textContent   = s.destination || 'Destination';
    $('#progressFill').style.width        = `${progressPct}%`;

    // Render route insights for this shipment
    const insightsSection = $('#detailInsightsSection');
    const insightsEl = $('#detailInsights');
    const shipInsights = getShipmentInsights(s);
    if (shipInsights.length > 0) {
        insightsSection.style.display = '';
        insightsEl.innerHTML = shipInsights.map((ins) => `
            <div class="detail-insight-item">
                <div class="detail-insight-icon ${ins.icon}">${ins.emoji}</div>
                <div>${ins.text}</div>
            </div>
        `).join('');
    } else {
        insightsSection.style.display = 'none';
    }

    // Hide delete button in demo mode
    const deleteSection = detailPanel.querySelector('.detail-delete-section');
    if (deleteSection) deleteSection.style.display = isDemoMode ? 'none' : '';

    detailPanel.classList.add('active');

    // Scroll left panel to Analytics heading when View Details button is clicked
    if (scrollToAnalytics) {
        const chartEl = $('#chartSection');
        if (chartEl) {
            setTimeout(() => {
                chartEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    }
}

function closeDetailPanel() {
    detailPanel.classList.remove('active');
    currentDetailShipmentId = null;
    document.querySelectorAll('.shipment-card').forEach((c) => c.classList.remove('active'));
}

async function deleteShipment() {
    if (!currentDetailShipmentId) return;
    const s = shipments.find((sh) => sh.id === currentDetailShipmentId);
    if (!s) return;
    if (!confirm(`Delete container ${s.container_number}? This cannot be undone.`)) return;

    const { error } = await sb.from('shipping_shipments').delete().eq('id', s.id);
    if (error) {
        showToast(`Failed to delete: ${error.message}`, 'error');
        return;
    }

    // Remove marker from map
    if (markers[s.id]) {
        map.removeLayer(markers[s.id]);
        delete markers[s.id];
    }

    shipments = shipments.filter((sh) => sh.id !== s.id);
    closeDetailPanel();
    renderShipmentList();
    updateAnalytics();
    showToast(`${s.container_number} deleted`, 'success');
}

function computeProgress(s) {
    if (s.status === 'delivered') return 100;
    if (s.status === 'pending') return 0;
    if (s.days_transit != null && s.eta) {
        const etaDate = new Date(s.eta);
        const now     = new Date();
        const msLeft  = etaDate - now;
        const totalMs = s.days_transit * 86400000 + msLeft;
        if (totalMs <= 0) return 95;
        const pct = Math.round((s.days_transit * 86400000 / totalMs) * 100);
        return Math.min(Math.max(pct, 5), 95);
    }
    return 25; // fallback for in-progress without full data
}

/* ══════════════════════════════════════════════════════════════════
   CHART.JS — Average Transit Days by Route
   ══════════════════════════════════════════════════════════════════ */

function initChart() {
    if (transitChart) return;

    const ctx = document.getElementById('transitChart').getContext('2d');

    transitChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: [],
            datasets: [{
                label: 'Avg. Transit Days',
                data: [],
                backgroundColor: 'rgba(26, 115, 232, 0.15)',
                borderColor: '#1a73e8',
                borderWidth: 1.5,
                borderRadius: 6,
                barPercentage: 0.6,
                categoryPercentage: 0.7
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#202124',
                    titleFont: { family: 'Roboto', weight: '600' },
                    bodyFont: { family: 'Roboto' },
                    cornerRadius: 8,
                    padding: 10,
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y} days`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        font: { family: 'Roboto', size: 11 },
                        color: '#5f6368',
                        callback: (v) => `${v}d`
                    },
                    grid: { color: '#f1f3f4' },
                    border: { display: false }
                },
                x: {
                    ticks: {
                        font: { family: 'Roboto', size: 11 },
                        color: '#5f6368',
                        maxRotation: 30
                    },
                    grid: { display: false },
                    border: { display: false }
                }
            }
        }
    });
}

function updateChart() {
    if (!transitChart) return;

    // Group by route_name and compute average days_transit
    const routeMap = {};
    shipments.forEach((s) => {
        const route = s.route_name || ((s.origin && s.destination) ? `${s.origin} → ${s.destination}` : null);
        if (!route || s.days_transit == null) return;
        if (!routeMap[route]) routeMap[route] = [];
        routeMap[route].push(s.days_transit);
    });

    const labels = Object.keys(routeMap);
    const data   = labels.map((r) => {
        const arr = routeMap[r];
        return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    });

    // If no real data, show placeholder routes
    if (!labels.length) {
        transitChart.data.labels   = ['Mombasa → UK', 'Jakarta → UK', 'Colombo → UK', 'Shanghai → UK'];
        transitChart.data.datasets[0].data = [28, 32, 22, 26];
    } else {
        transitChart.data.labels = labels;
        transitChart.data.datasets[0].data = data;
    }

    transitChart.update();
}

/* ══════════════════════════════════════════════════════════════════
   ANALYTICS — Route Intelligence
   ══════════════════════════════════════════════════════════════════ */

function computeRouteKey(s) {
    if (s.route_name) return s.route_name;
    if (s.origin && s.destination) return `${s.origin} → ${s.destination}`;
    return null;
}

function buildRouteStats() {
    const routes = {};

    shipments.forEach((s) => {
        const key = computeRouteKey(s);
        if (!key) return;
        if (!routes[key]) routes[key] = { shipments: [], days: [], delayed: 0, total: 0 };
        routes[key].shipments.push(s);
        routes[key].total++;
        if (s.days_transit != null) routes[key].days.push(s.days_transit);
        if (s.status === 'delayed') routes[key].delayed++;
    });

    return routes;
}

function updateAnalytics() {
    if (!shipments.length) {
        $('#statTotalShipments').textContent = '0';
        $('#statAvgTransit').textContent = '—';
        $('#statOnTime').textContent = '—';
        $('#statActive').textContent = '0';
        $('#insightsList').innerHTML = '<div class="insight-empty">Submit shipments to generate route intelligence.</div>';
        const tableCard = $('#routeTableCard');
        if (tableCard) tableCard.style.display = 'none';
        return;
    }

    const routes = buildRouteStats();

    // Summary stats
    const totalShipments = shipments.length;
    const activeShipments = shipments.filter((s) => ['moving', 'transshipment', 'pending'].includes(s.status)).length;
    const allDays = shipments.filter((s) => s.days_transit != null).map((s) => s.days_transit);
    const avgDays = allDays.length ? Math.round(allDays.reduce((a, b) => a + b, 0) / allDays.length) : null;

    const delayedCount = shipments.filter((s) => s.status === 'delayed').length;
    const completedOrActive = shipments.filter((s) => s.status !== 'pending').length;
    const onTimeRate = completedOrActive > 0 ? Math.round(((completedOrActive - delayedCount) / completedOrActive) * 100) : null;

    $('#statTotalShipments').textContent = totalShipments;
    $('#statAvgTransit').textContent = avgDays != null ? `${avgDays}d` : '—';
    $('#statOnTime').textContent = onTimeRate != null ? `${onTimeRate}%` : '—';
    $('#statActive').textContent = activeShipments;

    // Generate insights
    const insights = [];

    // Route-level analysis
    Object.entries(routes).forEach(([route, data]) => {
        const avg = data.days.length ? Math.round(data.days.reduce((a, b) => a + b, 0) / data.days.length) : null;
        const delayPct = data.total > 0 ? Math.round((data.delayed / data.total) * 100) : 0;

        // Transshipment delay detection
        const transshipments = data.shipments.filter((s) => s.status === 'transshipment');
        if (transshipments.length > 0) {
            const port = guessTransshipmentPort(route);
            insights.push({
                icon: 'amber',
                emoji: '⚓',
                text: `<strong>${port || 'Transshipment port'}</strong> on <strong>${route}</strong> — ${transshipments.length} container${transshipments.length > 1 ? 's' : ''} currently in transshipment. Monitor for potential delays.`
            });
        }

        // High delay rate
        if (delayPct >= 30 && data.total >= 2) {
            insights.push({
                icon: 'red',
                emoji: '⚠️',
                text: `<strong>${route}</strong> has a <strong>${delayPct}%</strong> delay rate across ${data.total} shipments. Consider alternative routing or buffer scheduling.`
            });
        }

        // Slowest route vs average
        if (avg != null && avgDays != null && avg > avgDays + 5 && data.days.length >= 2) {
            const diff = avg - avgDays;
            insights.push({
                icon: 'red',
                emoji: '🐢',
                text: `<strong>${route}</strong> averages <strong>${avg} days</strong> — ${diff} days longer than your overall average (${avgDays}d). This route may benefit from faster vessel booking.`
            });
        }

        // Fastest route highlight
        if (avg != null && avgDays != null && avg < avgDays - 3 && data.days.length >= 2) {
            const diff = avgDays - avg;
            insights.push({
                icon: 'green',
                emoji: '🚀',
                text: `<strong>${route}</strong> is your fastest route at <strong>${avg} days</strong> — ${diff} days quicker than average. Prioritise this for time-sensitive cargo.`
            });
        }
    });

    // Delayed shipments needing attention
    const delayedShipments = shipments.filter((s) => s.status === 'delayed');
    if (delayedShipments.length > 0) {
        insights.unshift({
            icon: 'red',
            emoji: '🚨',
            text: `<strong>${delayedShipments.length} shipment${delayedShipments.length > 1 ? 's' : ''} currently delayed</strong>: ${delayedShipments.map((s) => s.container_number).join(', ')}. Check with your freight forwarder for updated ETAs.`
        });
    }

    // ETA arriving soon
    const soonArrivals = shipments.filter((s) => {
        if (!s.eta || s.status === 'delivered') return false;
        const days = (new Date(s.eta) - Date.now()) / 86400000;
        return days >= 0 && days <= 7;
    });
    if (soonArrivals.length > 0) {
        insights.push({
            icon: 'blue',
            emoji: '📦',
            text: `<strong>${soonArrivals.length} arrival${soonArrivals.length > 1 ? 's' : ''} expected within 7 days</strong>: ${soonArrivals.map((s) => s.container_number).join(', ')}. Ensure customs clearance and logistics are arranged.`
        });
    }

    // Overall fleet health
    if (totalShipments >= 3 && onTimeRate != null) {
        if (onTimeRate >= 80) {
            insights.push({
                icon: 'green',
                emoji: '✅',
                text: `Your fleet on-time rate is <strong>${onTimeRate}%</strong>. Operations are running healthily.`
            });
        } else if (onTimeRate < 60) {
            insights.push({
                icon: 'red',
                emoji: '📉',
                text: `On-time rate is <strong>${onTimeRate}%</strong> — below the 60% threshold. Review delay patterns by route and consider diversifying shipping lines.`
            });
        }
    }

    // Render insights
    const insightsList = $('#insightsList');
    if (insights.length === 0) {
        insightsList.innerHTML = '<div class="insight-empty">Add more shipments with route data to unlock intelligence.</div>';
    } else {
        insightsList.innerHTML = insights.map((ins) => `
            <div class="insight-item">
                <div class="insight-icon ${ins.icon}">${ins.emoji}</div>
                <div class="insight-text">${ins.text}</div>
            </div>
        `).join('');
    }

    // Render Route Performance Table
    const routeEntries = Object.entries(routes).filter(([, d]) => d.days.length > 0);
    const tableCard = $('#routeTableCard');
    if (routeEntries.length === 0) {
        if (tableCard) tableCard.style.display = 'none';
        return;
    }

    if (tableCard) tableCard.style.display = '';
    const tbody = $('#routeTableBody');
    tbody.innerHTML = '';

    // Sort by total shipments descending
    routeEntries.sort((a, b) => b[1].total - a[1].total);

    routeEntries.forEach(([route, data]) => {
        const avg = Math.round(data.days.reduce((a, b) => a + b, 0) / data.days.length);
        const delayPct = data.total > 0 ? Math.round((data.delayed / data.total) * 100) : 0;

        // Trend: compare most recent half vs older half
        let trendHTML = '<span class="trend-flat">—</span>';
        if (data.days.length >= 2) {
            const half = Math.floor(data.days.length / 2);
            const older = data.days.slice(0, half);
            const newer = data.days.slice(half);
            const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
            const newerAvg = newer.reduce((a, b) => a + b, 0) / newer.length;
            const diff = Math.round(newerAvg - olderAvg);
            if (diff > 1) trendHTML = `<span class="trend-up">▲ +${diff}d</span>`;
            else if (diff < -1) trendHTML = `<span class="trend-down">▼ ${diff}d</span>`;
            else trendHTML = '<span class="trend-flat">→ stable</span>';
        }

        let delayClass = 'low';
        if (delayPct >= 40) delayClass = 'high';
        else if (delayPct >= 20) delayClass = 'med';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="route-name" title="${escapeHTML(route)}">${escapeHTML(route)}</td>
            <td>${data.total}</td>
            <td><strong>${avg}d</strong></td>
            <td><span class="delay-pct ${delayClass}">${delayPct}%</span></td>
            <td>${trendHTML}</td>
        `;
        tbody.appendChild(tr);
    });
}

function guessTransshipmentPort(route) {
    const lower = route.toLowerCase();
    const ports = ['salalah', 'colombo', 'singapore', 'port klang', 'jebel ali', 'dubai', 'piraeus', 'tanjung pelepas', 'rotterdam', 'hamburg'];
    for (const p of ports) {
        if (lower.includes(p)) return p.charAt(0).toUpperCase() + p.slice(1);
    }
    return null;
}

function getShipmentInsights(s) {
    const insights = [];
    const routeKey = computeRouteKey(s);
    if (!routeKey) return insights;

    const routeShipments = shipments.filter((sh) => computeRouteKey(sh) === routeKey);
    const routeDays = routeShipments.filter((sh) => sh.days_transit != null).map((sh) => sh.days_transit);
    const allDays = shipments.filter((sh) => sh.days_transit != null).map((sh) => sh.days_transit);

    const routeAvg = routeDays.length ? Math.round(routeDays.reduce((a, b) => a + b, 0) / routeDays.length) : null;
    const globalAvg = allDays.length ? Math.round(allDays.reduce((a, b) => a + b, 0) / allDays.length) : null;
    const routeDelayed = routeShipments.filter((sh) => sh.status === 'delayed').length;
    const routeDelayPct = routeShipments.length > 0 ? Math.round((routeDelayed / routeShipments.length) * 100) : 0;

    // This shipment vs route average
    if (s.days_transit != null && routeAvg != null && routeDays.length >= 2) {
        const diff = s.days_transit - routeAvg;
        if (diff > 3) {
            insights.push({ icon: 'red', emoji: '⏱️', text: `This shipment is <strong>${diff} days slower</strong> than the route average of ${routeAvg} days.` });
        } else if (diff < -3) {
            insights.push({ icon: 'green', emoji: '⚡', text: `This shipment is <strong>${Math.abs(diff)} days faster</strong> than the route average of ${routeAvg} days.` });
        } else {
            insights.push({ icon: 'blue', emoji: '📊', text: `Transit time is <strong>on par</strong> with the route average of ${routeAvg} days.` });
        }
    }

    // Route vs global average
    if (routeAvg != null && globalAvg != null && routeDays.length >= 2) {
        const diff = routeAvg - globalAvg;
        if (diff > 5) {
            insights.push({ icon: 'amber', emoji: '🐢', text: `This route averages <strong>${routeAvg}d</strong> — ${diff} days above your overall average (${globalAvg}d).` });
        } else if (diff < -3) {
            insights.push({ icon: 'green', emoji: '🚀', text: `This route averages <strong>${routeAvg}d</strong> — ${Math.abs(diff)} days faster than your overall average.` });
        }
    }

    // Route delay risk
    if (routeDelayPct >= 30 && routeShipments.length >= 2) {
        insights.push({ icon: 'red', emoji: '⚠️', text: `<strong>${routeDelayPct}%</strong> of shipments on this route have experienced delays. Factor extra buffer time.` });
    }

    // Transshipment info
    if (s.status === 'transshipment') {
        const port = guessTransshipmentPort(routeKey);
        insights.push({ icon: 'amber', emoji: '⚓', text: `Container is at transshipment${port ? ' near <strong>' + port + '</strong>' : ''}. Average dwell times at transshipment ports can add 3–7 days.` });
    }

    // ETA proximity
    if (s.eta && s.status !== 'delivered') {
        const daysLeft = Math.ceil((new Date(s.eta) - Date.now()) / 86400000);
        if (daysLeft <= 3 && daysLeft >= 0) {
            insights.push({ icon: 'blue', emoji: '📦', text: `Arriving in <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong>. Ensure customs documentation and haulage are ready.` });
        } else if (daysLeft < 0) {
            insights.push({ icon: 'red', emoji: '⏰', text: `ETA has <strong>passed</strong> by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) !== 1 ? 's' : ''}. Chase your forwarder for an update.` });
        }
    }

    // Number of shipments on this route
    if (routeShipments.length >= 2) {
        insights.push({ icon: 'blue', emoji: '📈', text: `You have <strong>${routeShipments.length} shipments</strong> on this route. Insights improve as more data is collected.` });
    }

    return insights;
}

/* ══════════════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════════════ */

function escapeHTML(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

function formatDate(dateStr) {
    try {
        return new Date(dateStr).toLocaleDateString('en-GB', {
            day: 'numeric', month: 'short', year: 'numeric'
        });
    } catch {
        return dateStr;
    }
}

function formatStatus(status) {
    const map = {
        moving: 'In Transit',
        transshipment: 'Transshipment',
        delayed: 'Delayed',
        pending: 'Pending',
        delivered: 'Delivered'
    };
    return map[status] || status;
}

function timeAgo(dateStr) {
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function showToast(message, isError) {
    toastMessage.textContent = message;
    toastEl.style.background = isError ? '#c5221f' : '#202124';
    toastEl.classList.add('visible');
    setTimeout(() => toastEl.classList.remove('visible'), 4000);
}

function getShipmentById(id) {
    return shipments.find((s) => String(s.id) === String(id));
}

/* ══════════════════════════════════════════════════════════════════
   NOTIFICATIONS
   ══════════════════════════════════════════════════════════════════ */

let notifications = [];
let notifPanelOpen = false;
let notifChannel = null;
let currentDetailShipmentId = null;

const NOTIF_ICONS = {
    status_change: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="m9 12 2 2 4-4"/></svg>',
    eta_change:    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    delay:         '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    arrival:       '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    new_tracking:  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>',
    info:          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
};

function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
}

async function loadNotifications() {
    if (!currentUser) return;

    try {
        const { data, error } = await sb
            .from('shipping_notifications')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) {
            console.error('Error loading notifications:', error.message);
            return;
        }

        notifications = data || [];
        renderNotifications();
    } catch (err) {
        console.error('Network error loading notifications:', err);
    }
}

function renderNotifications() {
    const list = $('#notifList');
    const empty = $('#notifEmpty');
    const unreadCount = notifications.filter((n) => !n.read).length;

    // Update badges
    ['notifBadge', 'notifBadgeLoggedOut'].forEach((id) => {
        const badge = document.getElementById(id);
        if (!badge) return;
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    });

    // Clear existing items (keep empty state element)
    list.querySelectorAll('.notif-item').forEach((el) => el.remove());

    if (!notifications.length) {
        if (empty) empty.style.display = '';
        return;
    }

    if (empty) empty.style.display = 'none';

    notifications.forEach((n) => {
        const item = document.createElement('div');
        item.className = `notif-item${n.read ? '' : ' unread'}`;
        item.dataset.id = n.id;
        item.innerHTML = `
            <div class="notif-icon ${n.type}">${NOTIF_ICONS[n.type] || NOTIF_ICONS.info}</div>
            <div class="notif-content">
                <div class="notif-title">${escapeHTML(n.title)}</div>
                <div class="notif-msg">${escapeHTML(n.message)}</div>
                <div class="notif-time">${timeAgo(n.created_at)}</div>
            </div>
            ${n.read ? '' : '<div class="notif-unread-dot"></div>'}
        `;
        item.addEventListener('click', () => markNotifRead(n));
        list.appendChild(item);
    });
}

async function markNotifRead(n) {
    if (n.read) {
        // Already read — if it has a shipment, open the detail
        if (n.shipment_id) {
            const s = shipments.find((sh) => String(sh.id) === String(n.shipment_id));
            if (s) openDetailPanel(s);
        }
        return;
    }

    n.read = true;
    renderNotifications();

    await sb
        .from('shipping_notifications')
        .update({ read: true })
        .eq('id', n.id);

    if (n.shipment_id) {
        const s = shipments.find((sh) => String(sh.id) === String(n.shipment_id));
        if (s) openDetailPanel(s);
    }
}

async function markAllNotifsRead() {
    const unread = notifications.filter((n) => !n.read);
    if (!unread.length) return;

    unread.forEach((n) => { n.read = true; });
    renderNotifications();

    const ids = unread.map((n) => n.id);
    await sb
        .from('shipping_notifications')
        .update({ read: true })
        .in('id', ids);
}

function toggleNotifPanel() {
    const panel = $('#notifPanel');
    notifPanelOpen = !notifPanelOpen;
    panel.classList.toggle('hidden', !notifPanelOpen);

    // Close when clicking outside
    if (notifPanelOpen) {
        setTimeout(() => {
            document.addEventListener('click', closeNotifOnClickOutside);
        }, 0);
    }
}

function closeNotifOnClickOutside(e) {
    const panel = $('#notifPanel');
    const bell1 = $('#notifBell');
    const bell2 = $('#notifBellLoggedOut');
    if (panel && !panel.contains(e.target)
        && (!bell1 || !bell1.contains(e.target))
        && (!bell2 || !bell2.contains(e.target))) {
        notifPanelOpen = false;
        panel.classList.add('hidden');
        document.removeEventListener('click', closeNotifOnClickOutside);
    }
}

// Wire up mark-all-read button
document.getElementById('notifMarkAll')?.addEventListener('click', markAllNotifsRead);

// Subscribe to real-time notification inserts
function subscribeToNotifications() {
    if (!currentUser) return;
    if (notifChannel) sb.removeChannel(notifChannel);

    notifChannel = sb.channel('shipping-notifications')
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'shipping_notifications',
            filter: `user_id=eq.${currentUser.id}`
        }, (payload) => {
            notifications.unshift(payload.new);
            renderNotifications();
            showToast(payload.new.title);
        })
        .subscribe();
}

/* ══════════════════════════════════════════════════════════════════
   EXPORT DATA
   ══════════════════════════════════════════════════════════════════ */

function exportData() {
    if (!currentUser) {
        const authOverlay = $('#authOverlay');
        if (authOverlay) authOverlay.classList.remove('hidden');
        return;
    }

    if (!shipments.length) {
        showToast('No shipment data to export.', true);
        return;
    }

    const headers = [
        'Container Number',
        'Status',
        'Origin',
        'Destination',
        'Route Name',
        'Latitude',
        'Longitude',
        'ETA',
        'Days in Transit',
        'Created',
        'Last Updated'
    ];

    const rows = shipments.map((s) => [
        s.container_number || '',
        s.status || '',
        s.origin || '',
        s.destination || '',
        s.route_name || '',
        s.lat != null ? s.lat : '',
        s.lng != null ? s.lng : '',
        s.eta ? new Date(s.eta).toLocaleDateString('en-GB') : '',
        s.days_transit != null ? s.days_transit : '',
        s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB') : '',
        s.updated_at ? new Date(s.updated_at).toLocaleDateString('en-GB') : ''
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map((row) => row.map((cell) => {
            const str = String(cell);
            // Escape commas and quotes
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        }).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `teatrade-shipments-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    showToast('Shipment data exported successfully.');
}

/* ══════════════════════════════════════════════════════════════════
   LIVE TRACKING — TimeToCargo API via Edge Function
   ══════════════════════════════════════════════════════════════════ */

const TRACK_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/track-container`;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const REQUEST_GAP_MS = 8000; // 8s between API calls (rate limit: 8 req/min)
let refreshTimer = null;

async function fetchTrackingData(containerNumber) {
    const res = await fetch(TRACK_FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container_number: containerNumber })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Tracking API error ${res.status}`);
    }
    return res.json();
}

async function refreshShipment(s) {
    try {
        // Re-read the shipment from DB to get the latest state
        // (the server-side cron may have already updated it)
        const { data: freshRow } = await sb
            .from('shipping_shipments')
            .select('*')
            .eq('id', s.id)
            .single();
        const current = freshRow || s;

        // Sync local object with DB state first
        Object.assign(s, current);

        const data = await fetchTrackingData(current.container_number);
        if (!data || (!data.status && data.lat == null)) return null;

        // Build update object — only include fields that actually changed
        const updates = {};

        if (data.status && data.status !== current.status) {
            updates.status = data.status;
        }
        // Always accept coordinate updates (the edge function now computes
        // smart positions — interpolated for in-transit, POD for delivered)
        if (data.lat != null && data.lng != null) {
            if (data.lat !== current.lat || data.lng !== current.lng) {
                updates.lat = data.lat;
                updates.lng = data.lng;
            }
        }
        if (data.eta && data.eta !== current.eta) {
            updates.eta = data.eta;
        }
        if (data.origin && !current.origin) {
            updates.origin = data.origin;
        }
        if (data.destination && !current.destination) {
            updates.destination = data.destination;
        }
        if (data.origin && data.destination && !current.route_name) {
            updates.route_name = `${data.origin} → ${data.destination}`;
        }
        // Compute days_transit from POL to now (or ETA)
        if (data.eta && data.origin) {
            const etaDate = new Date(data.eta);
            const now = new Date();
            const refDate = data.status === 'delivered' ? etaDate : now;
            const departed = new Date(current.created_at);
            const days = Math.max(0, Math.round((refDate - departed) / 86400000));
            if (days !== current.days_transit) {
                updates.days_transit = days;
            }
        }

        // Nothing changed — skip DB write
        if (Object.keys(updates).length === 0) return null;

        // Write to DB — the BEFORE UPDATE trigger saves old data to shipment_history
        updates.updated_at = new Date().toISOString();
        const { error } = await sb
            .from('shipping_shipments')
            .update(updates)
            .eq('id', s.id);

        if (error) {
            console.error(`Failed to update ${current.container_number}:`, error.message);
            return null;
        }

        // Sync local shipment object with updates
        Object.assign(s, updates);

        // NOTE: Notifications are created exclusively by the server-side cron
        // (refresh-all-tracking) to prevent duplicate notifications from
        // both frontend and cron firing on the same status change.

        return updates;
    } catch (err) {
        console.error(`Tracking error for ${s.container_number}:`, err.message);
        return null;
    }
}

function buildTrackingNotification(shipment, newData, statusChanged, etaChanged) {
    let type = 'status_change';
    let title = '';
    let message = '';

    if (statusChanged && newData.status === 'delayed') {
        type = 'delay';
        title = `${shipment.container_number} — Delay Detected`;
        message = `Container status changed to delayed. ${newData.eta ? 'New ETA: ' + new Date(newData.eta).toLocaleDateString('en-GB') : 'ETA pending.'}`;
    } else if (statusChanged && newData.status === 'delivered') {
        type = 'arrival';
        title = `${shipment.container_number} — Delivered`;
        message = `Container has arrived at ${newData.destination || 'destination'}.`;
    } else if (statusChanged) {
        type = 'status_change';
        title = `${shipment.container_number} — Status Update`;
        message = `Status changed from ${formatStatus(shipment.status)} to ${formatStatus(newData.status)}.`;
    } else if (etaChanged) {
        type = 'eta_change';
        title = `${shipment.container_number} — ETA Updated`;
        const oldEta = shipment.eta ? new Date(shipment.eta).toLocaleDateString('en-GB') : 'TBC';
        const newEta = new Date(newData.eta).toLocaleDateString('en-GB');
        message = `ETA changed from ${oldEta} to ${newEta}.`;
    }

    return {
        user_id: currentUser.id,
        shipment_id: shipment.id,
        type,
        title,
        message,
        read: false
    };
}

async function refreshAllShipments() {
    if (!currentUser || !shipments.length) return;

    // Include non-delivered shipments for tracking, plus any delivered
    // shipments whose coordinates look stale (not at their destination)
    const trackable = shipments.filter((s) => {
        if (s.status !== 'delivered') return true;
        // If delivered but lat/lng hasn't been corrected yet, refresh once
        if (s._positionCorrected) return false;
        return true;
    });
    if (!trackable.length) return;

    let updated = 0;

    for (let i = 0; i < trackable.length; i++) {
        const result = await refreshShipment(trackable[i]);
        if (result) updated++;
        // Mark delivered shipments so we don't re-fetch them every cycle
        if (trackable[i].status === 'delivered') {
            trackable[i]._positionCorrected = true;
        }

        // Stagger requests to stay under TimeToCargo's 8 req/min limit
        if (i < trackable.length - 1) {
            await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
        }
    }

    if (updated > 0) {
        await loadShipments(); // Re-render with fresh DB data
        showToast(`${updated} shipment${updated > 1 ? 's' : ''} updated with live tracking data.`);
    }
}

function startAutoRefresh() {
    stopAutoRefresh();
    refreshTimer = setInterval(refreshAllShipments, REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

/* ══════════════════════════════════════════════════════════════════
   DEMO DATA — realistic shipments for signed-out visitors
   Dates are computed relative to NOW so they never go stale.
   ══════════════════════════════════════════════════════════════════ */

let isDemoMode = false;

function getDemoShipments() {
    const now = Date.now();
    const day = 86400000;

    // Helper: date offset from now (positive = future, negative = past)
    const d = (offset) => new Date(now + offset * day).toISOString();

    return [
        {
            id: 'demo-1',
            container_number: 'MSCU7294813',
            status: 'moving',
            origin: 'Mombasa',
            destination: 'Felixstowe',
            route_name: 'Mombasa → Felixstowe',
            lat: 12.28,
            lng: 47.15,
            eta: d(14),
            days_transit: 18,
            created_at: d(-18),
            updated_at: d(-0.25)
        },
        {
            id: 'demo-2',
            container_number: 'TGHU5018472',
            status: 'transshipment',
            origin: 'Colombo',
            destination: 'London Gateway',
            route_name: 'Colombo → London Gateway',
            lat: 16.95,
            lng: 54.00,
            eta: d(11),
            days_transit: 22,
            created_at: d(-22),
            updated_at: d(-0.5)
        },
        {
            id: 'demo-3',
            container_number: 'CMAU3846190',
            status: 'moving',
            origin: 'Shanghai',
            destination: 'Felixstowe',
            route_name: 'Shanghai → Felixstowe',
            lat: 5.20,
            lng: 73.80,
            eta: d(9),
            days_transit: 26,
            created_at: d(-26),
            updated_at: d(-0.3)
        },
        {
            id: 'demo-4',
            container_number: 'HLXU9037254',
            status: 'delayed',
            origin: 'Jakarta',
            destination: 'Southampton',
            route_name: 'Jakarta → Southampton',
            lat: 1.26,
            lng: 103.83,
            eta: d(18),
            days_transit: 32,
            created_at: d(-32),
            updated_at: d(-1)
        },
        {
            id: 'demo-5',
            container_number: 'OOLU6172038',
            status: 'delivered',
            origin: 'Mombasa',
            destination: 'Felixstowe',
            route_name: 'Mombasa → Felixstowe',
            lat: 51.96,
            lng: 1.35,
            eta: d(-3),
            days_transit: 25,
            created_at: d(-28),
            updated_at: d(-3)
        },
        {
            id: 'demo-6',
            container_number: 'EGLV4289516',
            status: 'moving',
            origin: 'Colombo',
            destination: 'Felixstowe',
            route_name: 'Colombo → Felixstowe',
            lat: -1.30,
            lng: 36.80,
            eta: d(20),
            days_transit: 19,
            created_at: d(-5),
            updated_at: d(-0.4)
        }
    ];
}

function loadDemoData() {
    isDemoMode = true;
    shipments = getDemoShipments();
    renderShipmentList();
    plotShipments();
    updateChart();
    updateAnalytics();
}

function clearDemoData() {
    if (!isDemoMode) return;
    isDemoMode = false;
    shipments = [];
    // Remove demo markers from map
    Object.keys(markers).forEach((id) => {
        if (id.startsWith('demo-')) {
            map.removeLayer(markers[id]);
            delete markers[id];
        }
    });
    renderShipmentList();
    updateChart();
    updateAnalytics();
}

/* ══════════════════════════════════════════════════════════════════
   MOBILE PANEL TOGGLES
   ══════════════════════════════════════════════════════════════════ */

function isMobile() {
    return window.innerWidth <= 900;
}

function toggleMobileLeftPanel() {
    const panel = document.getElementById('leftPanel');
    const backdrop = document.getElementById('mobileBackdrop');
    const toggleBtn = document.getElementById('mobileLeftToggle');
    if (!panel) return;
    const isOpen = panel.classList.toggle('mobile-open');
    if (backdrop) backdrop.classList.toggle('active', isOpen);
    if (toggleBtn) toggleBtn.classList.toggle('hidden-toggle', isOpen);
}

function closeMobileLeftPanel() {
    const panel = document.getElementById('leftPanel');
    const backdrop = document.getElementById('mobileBackdrop');
    const toggleBtn = document.getElementById('mobileLeftToggle');
    if (panel) panel.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.remove('active');
    if (toggleBtn) toggleBtn.classList.remove('hidden-toggle');
}

// Override openDetailPanel to close left panel on mobile
const _origOpenDetailPanel = openDetailPanel;
function mobileAwareOpenDetailPanel(s, scrollToAnalytics) {
    if (isMobile()) closeMobileLeftPanel();
    _origOpenDetailPanel(s, scrollToAnalytics);
}

/* ══════════════════════════════════════════════════════════════════
   PUBLIC API (for inline onclick handlers)
   ══════════════════════════════════════════════════════════════════ */

window.shippingApp = {
    toggleAuthMode,
    showForgotPassword,
    signOut,
    openDetailPanel: mobileAwareOpenDetailPanel,
    closeDetailPanel,
    getShipmentById,
    toggleNotifPanel,
    exportData,
    deleteShipment,
    toggleMobileLeftPanel
};
