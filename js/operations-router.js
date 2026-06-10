/**
 * operations-router.js — Entry point for the Operations page.
 *
 * Parses URL parameters, loads team config and data files, then delegates
 * rendering to either the VP view or Team view based on the `sem` parameter.
 *
 * Routing logic:
 *   - No `sem` param → VP-level operations view (all teams)
 *   - Valid `sem` param → Team-level view for that SEM
 *   - Invalid `sem` param → error state with link back to VP view
 *   - `display=true` → activates display mode (larger fonts, auto-refresh, no nav)
 *
 * Data loading uses Promise.allSettled so a single failed source doesn't
 * crash the page. Each data result is normalized to:
 *   { available: boolean, data: object|null, reason: string|null }
 */

import { deriveHistoricalPaths } from './operations-transforms.js';

// ─── Configuration ───────────────────────────────────────────────────────────

const TEAM_CONFIG_PATH = '../config/teams.json';
const TEAM_CONFIG_PATH_ALT = 'config/teams.json';
const MANIFEST_PATH = '../data/manifest.json';
const MANIFEST_PATH_ALT = 'data/manifest.json';

// ─── Data Fetching Helpers ───────────────────────────────────────────────────

/**
 * Fetch JSON from a relative path with error handling.
 * Returns parsed JSON on success, throws on failure.
 */
async function fetchJSON(path) {
    const response = await fetch(path);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} fetching ${path}`);
    }
    return response.json();
}

/**
 * Load team configuration from config/teams.json.
 * Returns the parsed config object or null if unavailable.
 */
async function fetchTeamConfig() {
    try {
        return await fetchJSON(TEAM_CONFIG_PATH);
    } catch (err) {
        // Fallback for flat deployment (GitHub Pages) where page is at root
        try {
            return await fetchJSON(TEAM_CONFIG_PATH_ALT);
        } catch (err2) {
            console.error('Failed to load team config:', err2);
            return null;
        }
    }
}

/**
 * Load the data manifest (data/manifest.json).
 * The manifest lists the latest data file paths for each collector.
 * Returns the parsed manifest or null if unavailable.
 */
async function loadManifest() {
    try {
        return await fetchJSON(MANIFEST_PATH);
    } catch (err) {
        // Fallback for flat deployment (GitHub Pages) where page is at root
        try {
            return await fetchJSON(MANIFEST_PATH_ALT);
        } catch (err2) {
            console.warn('Manifest unavailable, will derive paths from convention:', err2.message);
            return null;
        }
    }
}

/**
 * Load a single collector's current data file.
 *
 * If a manifest is available, uses the path listed there.
 * Otherwise, attempts to derive the path from the collector name
 * and today's date (convention: data/{collector}/{collector}_{YYYY-MM-DD}.json).
 *
 * Returns normalized result: { available, data, reason }
 */
async function loadCollectorData(manifest, collectorName) {
    let path = null;
    let altPath = null;

    // Try manifest first — it should have a key per collector pointing to the latest file
    if (manifest && manifest.collectors && manifest.collectors[collectorName]) {
        const latest = manifest.collectors[collectorName].latest;
        path = '../' + latest;
        altPath = latest;  // Flat deployment fallback (no ../ prefix)
    }

    // Fallback: derive path from convention
    if (!path) {
        const today = new Date().toISOString().split('T')[0];
        path = `../data/${collectorName}/${collectorName}_${today}.json`;
        altPath = `data/${collectorName}/${collectorName}_${today}.json`;
    }

    try {
        const data = await fetchJSON(path);
        return { available: true, data, reason: null };
    } catch (err) {
        // Fallback for flat deployment (GitHub Pages)
        if (altPath) {
            try {
                const data = await fetchJSON(altPath);
                return { available: true, data, reason: null };
            } catch (err2) {
                console.warn(`Collector data unavailable for ${collectorName}:`, err2.message);
                return { available: false, data: null, reason: 'fetch_failed' };
            }
        }
        console.warn(`Collector data unavailable for ${collectorName}:`, err.message);
        return { available: false, data: null, reason: 'fetch_failed' };
    }
}

/**
 * Load historical data for trend charts.
 *
 * For each collector, derives up to numWeeks prior file paths using
 * deriveHistoricalPaths, then fetches them all in parallel.
 * Failed fetches are silently skipped — we render whatever history is available.
 *
 * Returns an object keyed by collector name, each value an array of
 * successfully loaded data envelopes (oldest first).
 */
async function loadHistoricalData(collectors, numWeeks = 12) {
    const historical = {};

    // Build all fetch promises across all collectors
    const fetchTasks = [];
    for (const collector of collectors) {
        const paths = deriveHistoricalPaths(collector, numWeeks);
        for (const path of paths) {
            fetchTasks.push(
                fetchJSON(path)
                    .then(data => ({ collector, data, success: true }))
                    .catch(() => ({ collector, data: null, success: false }))
            );
        }
    }

    // Execute all fetches in parallel
    const results = await Promise.allSettled(fetchTasks);

    // Initialize collector arrays
    for (const collector of collectors) {
        historical[collector] = [];
    }

    // Collect successful results
    for (const result of results) {
        // Promise.allSettled wraps in { status, value }
        const entry = result.status === 'fulfilled' ? result.value : null;
        if (entry && entry.success && entry.data) {
            historical[entry.collector].push(entry.data);
        }
    }

    return historical;
}

// ─── Display Mode ────────────────────────────────────────────────────────────

// Guard against stacking intervals when init() is re-invoked by the refresh cycle
let displayModeInitialized = false;

/**
 * Initialize display mode — larger fonts, no hover states, auto-refresh.
 *
 * Adds the display-mode class to body and sets up a 5-minute refresh interval.
 * The interval calls refreshDisplayData() (not init()) to avoid re-registering
 * the interval or re-adding the CSS class on each cycle.
 *
 * Safe to call multiple times — the interval is only created once.
 */
function initDisplayMode({ refreshInterval = 300000 } = {}) {
    document.body.classList.add('display-mode');

    if (displayModeInitialized) return;
    displayModeInitialized = true;

    // Auto-refresh: re-fetch data and re-render without re-initializing display mode.
    // On failure, retain current display and retry next interval.
    setInterval(async () => {
        try {
            await refreshDisplayData();
        } catch (err) {
            console.warn('Display mode refresh failed, retaining current data:', err.message);
        }
    }, refreshInterval);
}

/**
 * Refresh data and re-render the current view without re-initializing display mode.
 * Disposes existing ECharts instances before re-rendering to prevent memory leaks.
 */
async function refreshDisplayData() {
    const params = new URLSearchParams(window.location.search);
    const semName = params.get('sem');

    const container = document.getElementById('app');
    if (!container) return;

    // Dispose all existing ECharts instances before re-rendering
    disposeAllCharts();

    // Load team config
    const teamConfig = await fetchTeamConfig();
    if (!teamConfig || !teamConfig.sems) return; // retain current display on config failure

    const manifest = await loadManifest();

    const [fsiResult, etrcResult, incidentResult, insightsResult] = await Promise.allSettled([
        loadCollectorData(manifest, 'fsi'),
        loadCollectorData(manifest, 'etrc'),
        loadCollectorData(manifest, 'incidents'),
        loadCollectorData(manifest, 'insights')
    ]);

    const fsiData = fsiResult.status === 'fulfilled'
        ? fsiResult.value
        : { available: false, data: null, reason: 'fetch_failed' };
    const etrcData = etrcResult.status === 'fulfilled'
        ? etrcResult.value
        : { available: false, data: null, reason: 'fetch_failed' };
    const incidentData = incidentResult.status === 'fulfilled'
        ? incidentResult.value
        : { available: false, data: null, reason: 'fetch_failed' };
    const insightsData = insightsResult.status === 'fulfilled'
        ? insightsResult.value
        : { available: false, data: null, reason: 'fetch_failed' };

    const historical = await loadHistoricalData(['fsi', 'etrc', 'incidents'], 12);
    const context = { teamConfig, fsiData, etrcData, incidentData, insightsData, historical, isDisplay: true };

    if (!semName) {
        await renderView('vp', container, context, semName);
    } else if (teamConfig.sems[semName]) {
        await renderView('team', container, context, semName);
    }
    // Invalid sem — don't re-render error state, retain current display
}

/**
 * Dispose all ECharts instances currently rendered on the page.
 * Prevents memory leaks and duplicate chart instances on refresh.
 */
function disposeAllCharts() {
    const chartContainers = document.querySelectorAll('.chart-container, .fsi-chart-container');
    for (const el of chartContainers) {
        const instance = echarts.getInstanceByDom(el);
        if (instance) {
            instance.dispose();
        }
    }
}

// ─── Error Rendering ─────────────────────────────────────────────────────────

/**
 * Render an error state when the SEM parameter doesn't match any configured SEM.
 * Shows the invalid name and a link back to the VP view.
 */
function renderInvalidSEM(container, semName) {
    container.innerHTML = `
        <div class="ops-error-state">
            <h2>Unknown SEM: "${escapeHTML(semName)}"</h2>
            <p>No team configuration found for this name. Check the URL parameter.</p>
            <a href="operations.html" class="back-link">← Back to Operations Overview</a>
        </div>
    `;
}

/**
 * Render a fatal error when team config can't be loaded.
 * Without config, neither view can render.
 */
function renderConfigError(container) {
    container.innerHTML = `
        <div class="ops-error-state">
            <h2>Configuration Unavailable</h2>
            <p>Could not load team configuration from ${TEAM_CONFIG_PATH}. 
               The operations dashboard requires this file to determine team assignments.</p>
            <a href="index.html" class="back-link">← Back to Executive Dashboard</a>
        </div>
    `;
}

/**
 * Minimal HTML escaping to prevent XSS from URL parameters.
 */
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Initialize the operations page.
 *
 * 1. Parse URL params (sem, display)
 * 2. Activate display mode if requested
 * 3. Load team config (required — without it, nothing renders)
 * 4. Load manifest (optional — graceful fallback)
 * 5. Load FSI, ETRC, incidents data in parallel
 * 6. Load historical data for trend charts
 * 7. Route to the appropriate view
 */
export async function init() {
    const params = new URLSearchParams(window.location.search);
    const semName = params.get('sem');
    const isDisplay = params.get('display') === 'true';

    const container = document.getElementById('app');
    if (!container) {
        console.error('No #app container found in DOM');
        return;
    }

    // Display mode: activate before rendering so CSS class is present
    if (isDisplay) {
        initDisplayMode({ refreshInterval: 300000 });
    }

    // Load team config — this is required for routing decisions
    const teamConfig = await fetchTeamConfig();
    if (!teamConfig || !teamConfig.sems) {
        renderConfigError(container);
        return;
    }

    // Load manifest (optional — we can derive paths without it)
    const manifest = await loadManifest();

    // Load all four data sources in parallel
    const [fsiResult, etrcResult, incidentResult, insightsResult] = await Promise.allSettled([
        loadCollectorData(manifest, 'fsi'),
        loadCollectorData(manifest, 'etrc'),
        loadCollectorData(manifest, 'incidents'),
        loadCollectorData(manifest, 'insights')
    ]);

    // Normalize Promise.allSettled results to our standard shape
    const fsiData = fsiResult.status === 'fulfilled'
        ? fsiResult.value
        : { available: false, data: null, reason: 'fetch_failed' };
    const etrcData = etrcResult.status === 'fulfilled'
        ? etrcResult.value
        : { available: false, data: null, reason: 'fetch_failed' };
    const incidentData = incidentResult.status === 'fulfilled'
        ? incidentResult.value
        : { available: false, data: null, reason: 'fetch_failed' };
    const insightsData = insightsResult.status === 'fulfilled'
        ? insightsResult.value
        : { available: false, data: null, reason: 'fetch_failed' };

    // Load historical data for trend charts (up to 12 prior weeks per collector)
    const historical = await loadHistoricalData(['fsi', 'etrc', 'incidents'], 12);

    // Build the context object passed to renderers
    const context = { teamConfig, fsiData, etrcData, incidentData, insightsData, historical, isDisplay };

    // Route based on URL parameters
    if (!semName) {
        // No sem param → VP-level view
        await renderView('vp', container, context, semName);
    } else if (teamConfig.sems[semName]) {
        // Valid sem param → Team-level view
        await renderView('team', container, context, semName);
    } else {
        // Invalid sem param → error state
        renderInvalidSEM(container, semName);
    }
}

/**
 * Dynamically import and invoke the appropriate view renderer.
 *
 * Uses dynamic import so the page doesn't error when vp-operations.js
 * or team-operations.js don't exist yet. Falls back to a "coming soon"
 * message if the module can't be loaded.
 */
async function renderView(viewType, container, context, semName) {
    try {
        if (viewType === 'vp') {
            const { renderVPView } = await import('./vp-operations.js?v=6');
            renderVPView(container, context);
        } else {
            const { renderTeamView } = await import('./team-operations.js?v=6');
            renderTeamView(container, semName, context);
        }
    } catch (err) {
        console.warn(`View module not yet available (${viewType}):`, err.message);
        container.innerHTML = `
            <div class="ops-error-state">
                <h2>Operations ${viewType === 'vp' ? 'Overview' : `Team: ${escapeHTML(semName)}`}</h2>
                <p>View renderer is not yet implemented. Data loading succeeded — 
                   the rendering module will be available in a subsequent build.</p>
                <p class="text-muted">Module: ${viewType === 'vp' ? 'vp-operations.js' : 'team-operations.js'}</p>
                ${viewType === 'team' ? '<a href="operations.html" class="back-link">← Back to Operations Overview</a>' : '<a href="index.html" class="back-link">← Back to Executive Dashboard</a>'}
            </div>
        `;
    }
}

// ─── Auto-init on page load ──────────────────────────────────────────────────

init();
