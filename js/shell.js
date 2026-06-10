/**
 * shell.js — Module Loader for the SLS Executive Dashboard
 * 
 * Orchestrates dynamic import of quadrant modules from quadrant-registry.json.
 * Each module is loaded independently with a 5-second timeout covering import() + init().
 * Failed or placeholder modules get a CSS-rendered test card placeholder.
 * 
 * Exports: initShell() — called from index.html on DOMContentLoaded.
 */

// All five slot IDs that must be populated on failure
const ALL_SLOT_IDS = [
    'quadrant-delivery',
    'quadrant-operations',
    'quadrant-security',
    'quadrant-finance',
    'quadrant-sentiment'
];

// Shell state — tracks loaded modules and refresh timer
const state = {
    modules: new Map(),
    refreshInterval: 300000,
    refreshTimerId: null
};

/**
 * Entry point — called from index.html on DOMContentLoaded.
 * Fetches the registry, loads all modules, sets up periodic refresh.
 */
export async function initShell() {
    let registry;

    try {
        const response = await fetch('quadrant-registry.json');
        if (!response.ok) {
            throw new Error(`Registry fetch failed: HTTP ${response.status}`);
        }
        registry = await response.json();
    } catch (err) {
        // Registry unreachable or malformed JSON — render test cards in all 5 slots
        console.error('[shell] Registry load failed:', err.message || err);
        renderTestCardInAllSlots();
        return;
    }

    // Validate registry structure — must have a quadrants array
    if (!registry || !Array.isArray(registry.quadrants)) {
        console.error('[shell] Invalid registry: missing quadrants array');
        renderTestCardInAllSlots();
        return;
    }

    // Load all modules concurrently
    await loadModules(registry);

    // Set up periodic refresh with floor enforcement (min 60s)
    const interval = Math.max(registry.refreshInterval || 0, 60000);
    state.refreshInterval = interval;
    state.refreshTimerId = setInterval(() => refreshAll(), interval);
}

/**
 * Loads all modules from the registry concurrently.
 * Each entry is processed independently — failures don't cascade.
 */
export async function loadModules(registry) {
    const timeoutMs = registry.loadTimeout || 5000;

    const results = await Promise.allSettled(
        registry.quadrants.map(entry => loadSingleModule(entry, timeoutMs))
    );

    return results;
}

/**
 * Loads a single module into its slot container.
 * 
 * Behavior:
 * - status === 'placeholder': render test card immediately, no import()
 * - status === 'active': show skeleton, race import()+init() against timeout
 * - On success: wire click-through navigation if detailUrl is defined
 * - On timeout/error: replace skeleton with "Unavailable" test card
 */
export async function loadSingleModule(entry, timeoutMs) {
    const container = document.getElementById(entry.slotId);
    if (!container) {
        console.error(`[shell] Slot not found: ${entry.slotId}`);
        return;
    }

    // Placeholder entries get a test card immediately — no import() attempted
    if (entry.status === 'placeholder') {
        renderTestCard(container, entry, 'Coming Soon');
        state.modules.set(entry.slotId, {
            entry,
            module: null,
            status: 'placeholder',
            container
        });
        return;
    }

    // Active entry: show loading skeleton while module loads
    renderSkeleton(container);

    try {
        // Resolve modulePath relative to the page URL (not relative to shell.js).
        // Registry paths like "./quadrants/operations/index.js" are relative to index.html.
        const resolvedPath = new URL(entry.modulePath, window.location.href).href;

        // Single 5s timeout covers the entire import() + init() sequence
        const loadedModule = await Promise.race([
            import(resolvedPath).then(m => {
                return m.init(container).then(() => m);
            }),
            rejectAfter(timeoutMs)
        ]);

        // Success — inject card title and wire navigation
        injectCardTitle(container, entry);
        wireNavigation(container, loadedModule.detailUrl, entry);

        state.modules.set(entry.slotId, {
            entry,
            module: loadedModule,
            status: 'loaded',
            container
        });
    } catch (err) {
        // Timeout or any error: replace skeleton with test card
        renderTestCard(container, entry, 'Unavailable');
        state.modules.set(entry.slotId, {
            entry,
            module: null,
            status: 'failed',
            container
        });
    }
}

/**
 * Invokes refresh() on all loaded modules concurrently.
 * Each module gets a 30-second timeout. Failed modules show an error indicator;
 * others complete independently via Promise.allSettled.
 */
export async function refreshAll() {
    const refreshPromises = [];

    for (const [slotId, loaded] of state.modules) {
        // Only refresh modules that loaded successfully and export refresh()
        if (loaded.status !== 'loaded' || !loaded.module || typeof loaded.module.refresh !== 'function') {
            continue;
        }

        const refreshWithTimeout = Promise.race([
            loaded.module.refresh(),
            rejectAfter(30000)
        ]).then(() => {
            // Re-inject title after successful refresh (module re-renders innerHTML)
            injectCardTitle(loaded.container, loaded.entry);
        }).catch(err => {
            // Failed refresh: show error indicator on the module's container
            showRefreshError(loaded.container, loaded.entry);
            console.error(`[shell] Refresh failed for ${slotId}:`, err.message || err);
            // Still re-inject title in case error state preserved the card
            injectCardTitle(loaded.container, loaded.entry);
        });

        refreshPromises.push(refreshWithTimeout);
    }

    await Promise.allSettled(refreshPromises);

    // Update last-updated timestamp on successful refresh cycle
    updateTimestamp();
}

// ─────────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────────

/**
 * Renders a loading skeleton placeholder in the slot.
 * Matches slot dimensions — replaced when module loads or times out.
 */
function renderSkeleton(container) {
    container.innerHTML = `
        <div class="quadrant-card quadrant-skeleton" aria-busy="true" aria-label="Loading...">
            <div class="skeleton-line skeleton-line-short"></div>
            <div class="skeleton-line skeleton-line-long"></div>
            <div class="skeleton-line skeleton-line-medium"></div>
            <div class="skeleton-line skeleton-line-long"></div>
        </div>
    `;
}

/**
 * Renders a CSS-only test card placeholder (color-bar broadcast pattern).
 * Used for placeholders ("Coming Soon") and failures ("Unavailable").
 */
function renderTestCard(container, entry, statusText) {
    container.innerHTML = `
        <div class="quadrant-card quadrant-test-card" data-attention-level="red">
            <div class="test-card-bars"></div>
            <div class="test-card-content">
                <span class="test-card-icon">${escapeHtml(entry.icon || '⬜')}</span>
                <span class="test-card-label">${escapeHtml(entry.label || 'Unknown')}</span>
                <span class="test-card-status">${escapeHtml(statusText)}</span>
            </div>
        </div>
    `;

    // No navigation on test cards — tabindex -1, no pointer
    const card = container.querySelector('.quadrant-card');
    if (card) {
        card.setAttribute('tabindex', '-1');
    }
}

/**
 * Renders test cards in all 5 slots — used when registry itself is broken.
 */
function renderTestCardInAllSlots() {
    // Default entries for the fallback case — enough info to render a meaningful test card
    const fallbackEntries = [
        { slotId: 'quadrant-delivery', label: 'Delivery', icon: '📦' },
        { slotId: 'quadrant-operations', label: 'Operations', icon: '⚙️' },
        { slotId: 'quadrant-security', label: 'Security', icon: '🔒' },
        { slotId: 'quadrant-finance', label: 'Finance', icon: '💰' },
        { slotId: 'quadrant-sentiment', label: 'Student Sentiment', icon: '💬' }
    ];

    for (const entry of fallbackEntries) {
        const container = document.getElementById(entry.slotId);
        if (container) {
            renderTestCard(container, entry, 'Unavailable');
        }
    }
}

/**
 * Shows a transient error indicator on a module's container after a refresh failure.
 * The module itself handles preserving last-good content per contract (Req 4.4).
 * This adds a shell-level visual cue that the refresh cycle failed.
 */
function showRefreshError(container, entry) {
    // Add an error indicator class to the existing card — don't replace content
    const card = container.querySelector('.quadrant-card');
    if (card) {
        card.classList.add('refresh-error');
        // Remove the indicator after 10 seconds so it doesn't persist forever
        setTimeout(() => card.classList.remove('refresh-error'), 10000);
    }
}

// ─────────────────────────────────────────────────────────────
// Card title injection
// ─────────────────────────────────────────────────────────────

/**
 * Prepend a title element ABOVE the module's .quadrant-card in the slot container.
 * Uses the label from the registry entry. Positioned in the slot container (not
 * inside the card) so it's never hidden behind the sentiment overlay.
 * Skips the center overlay (sentiment) — it has its own internal heading.
 * Idempotent — won't add duplicate titles on re-init.
 */
function injectCardTitle(container, entry) {
    // Center overlay renders its own title — skip shell-level injection
    if (entry.position === 'center-overlay') return;

    // Don't duplicate if already present (e.g., re-init or refresh path)
    if (container.querySelector('.quadrant-card-title')) return;

    const title = document.createElement('span');
    title.className = 'quadrant-card-title';
    title.textContent = entry.label || '';
    // Insert before the card element so the title sits above it in the slot
    container.prepend(title);
}

// ─────────────────────────────────────────────────────────────
// Navigation wiring
// ─────────────────────────────────────────────────────────────

/**
 * Wires click-through navigation on a successfully loaded module's card.
 * 
 * If detailUrl is non-null and ≤ 256 chars:
 *   - tabindex="0", pointer cursor, click-arrow affordance, click/Enter/Space handlers
 *   - Before navigating: HEAD fetch to verify target exists (Req 8.4)
 *   - On 4xx/5xx: remain on landing page, show inline error for ≥ 3s
 * If detailUrl is null:
 *   - tabindex="-1", no cursor, no arrow
 */
function wireNavigation(container, detailUrl, entry) {
    const card = container.querySelector('.quadrant-card');
    if (!card) return;

    if (detailUrl && typeof detailUrl === 'string' && detailUrl.length <= 256) {
        // Active navigation — card is clickable
        card.setAttribute('tabindex', '0');
        card.setAttribute('data-clickable', '');
        card.setAttribute('role', 'link');
        card.setAttribute('aria-label', `${entry.label} — click to view details`);

        // "View details →" affordance — top-right of card, inline with hero
        const detailLink = document.createElement('span');
        detailLink.className = 'card-nav-arrow';
        detailLink.textContent = 'View details →';
        detailLink.setAttribute('aria-hidden', 'true');
        card.appendChild(detailLink);

        // Navigation handler — verifies target before navigating
        const navigate = () => navigateWithCheck(card, detailUrl);

        // Click handler
        card.addEventListener('click', navigate);

        // Keyboard handler — Enter and Space trigger navigation
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                navigate();
            }
        });
    } else {
        // No navigation — card is not interactive
        card.setAttribute('tabindex', '-1');
    }
}

/**
 * Verify navigation target with a HEAD fetch before navigating.
 * If the target returns 4xx/5xx, remain on landing page and show
 * an inline error on the card for at least 3 seconds (Req 8.4).
 */
async function navigateWithCheck(card, detailUrl) {
    try {
        const response = await fetch(detailUrl, { method: 'HEAD' });
        if (response.ok) {
            window.location.href = detailUrl;
        } else {
            showNavigationError(card);
        }
    } catch {
        // Network error — treat same as 4xx/5xx, stay on landing page
        showNavigationError(card);
    }
}

/**
 * Show inline error on a card when navigation target is unreachable.
 * Error persists for at least 3 seconds, then auto-removes.
 */
function showNavigationError(card) {
    // Don't stack multiple error indicators
    if (card.querySelector('.nav-error-indicator')) return;

    const indicator = document.createElement('div');
    indicator.className = 'nav-error-indicator';
    indicator.setAttribute('role', 'alert');
    indicator.textContent = 'Page unavailable';
    card.appendChild(indicator);

    // Remove after 3 seconds minimum
    setTimeout(() => {
        indicator.remove();
    }, 3000);
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Returns a Promise that rejects after the specified milliseconds.
 * Used for timeout racing against import()+init() and refresh().
 */
function rejectAfter(ms) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
}

/**
 * Updates the last-updated timestamp in the header.
 */
function updateTimestamp() {
    const el = document.getElementById('last-updated');
    if (el) {
        const now = new Date();
        el.textContent = `Last updated: ${now.toLocaleTimeString()}`;
        el.setAttribute('datetime', now.toISOString());
    }
}

/**
 * Minimal HTML escaping to prevent XSS from registry content.
 * Registry is a local static file, but defense in depth costs nothing.
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Export internals for testing
export { renderTestCard, renderSkeleton, wireNavigation, navigateWithCheck, showNavigationError, rejectAfter, injectCardTitle, state };
