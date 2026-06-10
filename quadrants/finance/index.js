/**
 * Finance Quadrant Module
 *
 * Renders a budget-variance table showing four expense categories
 * with MTD Actual, Budget, and Variance % columns. Drives the card's
 * attention color from Gross Expenditures variance. Integrates with the
 * shell via the standard quadrant contract: init/refresh/destroy/detailUrl.
 *
 * Pure utility functions are exported for testability.
 */

// --- Module state ---
let _container = null;
let _rootEl = null;
let _lastGoodData = null;
let _abortController = null;

export const detailUrl = null;

// --- Quadrant Contract functions ---

export async function init(containerElement) {
    // Re-initialization: clear previous container if switching targets
    if (_container && _container !== containerElement) {
        _container.innerHTML = '';
    }

    _container = containerElement;

    // Create root element with default pre-data attention level (red = unknown/error)
    _rootEl = document.createElement('div');
    _rootEl.className = 'quadrant-card';
    _rootEl.setAttribute('data-attention-level', 'red');

    _container.innerHTML = '';
    _container.appendChild(_rootEl);

    // Load CSS (idempotent)
    _loadCSS();

    // Fetch data, build state, render
    try {
        const envelope = await _fetchFinanceData();
        const state = _buildState(envelope);
        _lastGoodData = state;
        _applyState(state);
    } catch (err) {
        // Initial load failure — show error state, retain red attention
        _renderErrorState('Data unavailable');
    }
}

export async function refresh() {
    // Re-fetch data and re-render; on failure retain last good render + error banner
    try {
        const envelope = await _fetchFinanceData();
        const state = _buildState(envelope);
        _lastGoodData = state;
        _applyState(state);
    } catch (err) {
        if (_lastGoodData) {
            // Retain last render, show transient error banner (auto-remove 5-15s)
            _showRefreshError();
        } else {
            // No prior data — show empty state
            _renderEmptyState();
        }
    }
}

export async function destroy() {
    // Abort in-flight fetches before clearing state
    if (_abortController) {
        _abortController.abort();
        _abortController = null;
    }

    if (_container) {
        _container.innerHTML = '';
    }

    _container = null;
    _rootEl = null;
    _lastGoodData = null;
}

// --- Internal lifecycle helpers ---

/**
 * Apply a computed FinanceState to the card DOM.
 * Sets attention-level attribute and renders card or empty state.
 */
function _applyState(state) {
    if (!_rootEl) return;

    _rootEl.setAttribute('data-attention-level', state.attentionLevel);
    _rootEl.innerHTML = '';

    if (state.isEmpty) {
        const emptyEl = _renderEmptyState();
        _rootEl.appendChild(emptyEl);
    } else {
        const cardContent = _renderCard(state);
        _rootEl.appendChild(cardContent);
    }
}

/**
 * Inject <link> for finance.css (idempotent — keyed by element id).
 */
function _loadCSS() {
    const linkId = 'finance-module-css';
    if (document.getElementById(linkId)) return;

    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = 'quadrants/finance/finance.css';
    document.head.appendChild(link);
}

// --- Pure utility functions (exported for testing) ---

/**
 * Classify a variance decimal into an attention/color bucket.
 * Uses absolute value — direction doesn't matter, magnitude does.
 *
 * abs <= 0.02 → green (within budget tolerance)
 * abs <= 0.05 → yellow (watch)
 * abs >  0.05 → red (action needed)
 * null/non-finite → null (caller handles default)
 */
export function _classifyVariance(decimalValue) {
    if (decimalValue == null || typeof decimalValue !== 'number' || !isFinite(decimalValue)) {
        return null;
    }
    const abs = Math.abs(decimalValue);
    if (abs <= 0.02) return 'green';
    if (abs <= 0.05) return 'yellow';
    return 'red';
}

/**
 * Format a number as a dollar string with comma grouping, no decimals.
 * Negative values use "−" (U+2212) prefix before the "$".
 * Non-finite/null → "—" (em dash).
 */
export function _formatDollar(n) {
    if (n == null || typeof n !== 'number' || !isFinite(n)) return '\u2014';
    const abs = Math.abs(n);
    // Round to integer, then comma-group
    const formatted = Math.round(abs).toLocaleString('en-US');
    if (n < 0) return `\u2212$${formatted}`;
    return `$${formatted}`;
}

/**
 * Format a variance decimal as a percentage string.
 * Multiplies by 100, rounds to 1 decimal. "+" for positive, "−" for negative,
 * no prefix for 0.0%.
 * Non-finite/null → "—" (em dash).
 */
export function _formatVariancePercent(d) {
    if (d == null || typeof d !== 'number' || !isFinite(d)) return '\u2014';
    const pct = d * 100;
    const rounded = Math.abs(pct).toFixed(1);
    // Check if the rounded value is "0.0" (effectively zero after rounding)
    if (rounded === '0.0') return '0.0%';
    if (pct > 0) return `+${rounded}%`;
    return `\u2212${rounded}%`;
}

/**
 * Format a collected_at ISO timestamp into a relative or short-date label.
 * <7 days old → relative ("2h ago", "3d ago")
 * ≥7 days old → short date ("Jun 4")
 * Invalid/null → "" (empty string, never null)
 */
export function _formatCollectedLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';

    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    // 7 days = threshold for relative vs. short date
    if (diffDays >= 7) {
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[date.getMonth()]} ${date.getDate()}`;
    }

    // Relative: days, hours, minutes, or "just now"
    if (diffDays >= 1) return `${diffDays}d ago`;
    if (diffHours >= 1) return `${diffHours}h ago`;
    if (diffMinutes >= 1) return `${diffMinutes}m ago`;
    return 'just now';
}

/**
 * Extract the finance data file path from a parsed manifest object.
 * Throws if the path is missing, null, or empty string.
 */
export function _resolveFinancePath(manifest) {
    if (!manifest || !manifest.collectors || !manifest.collectors.finance) {
        throw new Error('Finance entry missing from manifest');
    }
    const latest = manifest.collectors.finance.latest;
    if (!latest || typeof latest !== 'string' || latest.trim() === '') {
        throw new Error('Finance latest path missing from manifest');
    }
    return latest;
}

// --- Rendering functions ---

/**
 * Render the full finance card DOM from computed FinanceState.
 * All DOM built via createElement — no innerHTML with dynamic data.
 *
 * Layout:
 * 1. Hero zone: score badge (top-right), period + freshness label
 * 2. Semantic table: 4 rows × 3 data columns
 */
export function _renderCard(state) {
    const card = document.createElement('div');
    card.className = 'finance-card-content';

    // --- Hero zone: score badge + period + timestamp ---
    const heroZone = document.createElement('div');
    heroZone.className = 'finance-hero-zone';

    // Score badge — Gross Expenditures variance %, colored by classification
    const scoreEl = document.createElement('span');
    scoreEl.className = 'finance-score';
    if (state.totalVariancePercent != null && isFinite(state.totalVariancePercent)) {
        scoreEl.textContent = _formatVariancePercent(state.totalVariancePercent);
        const colorClass = state.scoreColor;
        if (colorClass) {
            scoreEl.classList.add(`variance-${colorClass}`);
        }
    } else {
        scoreEl.textContent = '\u2014';
    }
    heroZone.appendChild(scoreEl);

    // Period label
    const periodEl = document.createElement('span');
    periodEl.className = 'finance-period';
    periodEl.textContent = state.period || 'Period unknown';
    heroZone.appendChild(periodEl);

    // Freshness / collected timestamp
    const timestampEl = document.createElement('span');
    timestampEl.className = 'finance-timestamp';
    timestampEl.textContent = _formatCollectedLabel(state.collectedAt);
    heroZone.appendChild(timestampEl);

    card.appendChild(heroZone);

    // --- Semantic table: header + 4 category rows ---
    const table = document.createElement('table');
    table.className = 'finance-table';

    // Colgroup for fixed column widths (controlled via CSS)
    const colgroup = document.createElement('colgroup');
    for (let i = 0; i < 4; i++) {
        colgroup.appendChild(document.createElement('col'));
    }
    table.appendChild(colgroup);

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const columns = ['', 'MTD Actual', 'Budget', 'Variance'];

    for (const col of columns) {
        const th = document.createElement('th');
        th.className = 'finance-th';
        th.textContent = col;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body: one row per category
    const tbody = document.createElement('tbody');

    for (const cat of state.categories) {
        const row = document.createElement('tr');

        // Category name
        const nameCell = document.createElement('td');
        nameCell.className = 'finance-td';
        nameCell.textContent = cat.name;
        row.appendChild(nameCell);

        // MTD Actual (dollar)
        const actualCell = document.createElement('td');
        actualCell.className = 'finance-td finance-dollar';
        actualCell.textContent = _formatDollar(cat.mtdActual);
        row.appendChild(actualCell);

        // Budget (dollar)
        const budgetCell = document.createElement('td');
        budgetCell.className = 'finance-td finance-dollar';
        budgetCell.textContent = _formatDollar(cat.budget);
        row.appendChild(budgetCell);

        // Variance % (colored by threshold)
        const varianceCell = document.createElement('td');
        varianceCell.className = 'finance-td finance-variance';
        const varianceColor = _classifyVariance(cat.variancePercent);
        if (varianceColor) {
            varianceCell.classList.add(`variance-${varianceColor}`);
        }
        varianceCell.textContent = _formatVariancePercent(cat.variancePercent);
        row.appendChild(varianceCell);

        tbody.appendChild(row);
    }

    table.appendChild(tbody);
    card.appendChild(table);
    return card;
}

/**
 * Render an error state into the root element when load fails.
 * Warning icon + message, centered in card.
 */
export function _renderErrorState(message) {
    if (!_rootEl) return;

    _rootEl.innerHTML = '';

    const errorEl = document.createElement('div');
    errorEl.className = 'finance-error';
    errorEl.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'finance-error-icon';
    icon.textContent = '\u26A0\uFE0F';
    errorEl.appendChild(icon);

    const msg = document.createElement('span');
    msg.className = 'finance-error-message';
    msg.textContent = message;
    errorEl.appendChild(msg);

    _rootEl.appendChild(errorEl);
}

/**
 * Render the empty state — no finance data available.
 * Returns the DOM element (also appends to _rootEl when called from refresh path).
 */
export function _renderEmptyState() {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'finance-empty';
    emptyEl.setAttribute('role', 'status');
    emptyEl.textContent = 'No finance data available';

    // If called in a context where we need to inject into root directly
    if (_rootEl && _rootEl.children.length === 0) {
        _rootEl.innerHTML = '';
        _rootEl.appendChild(emptyEl);
    }

    return emptyEl;
}

/**
 * Show transient refresh error banner above retained content.
 * Banner auto-removes after 5–15 seconds (10s default).
 * If no prior data, falls back to empty state.
 */
function _showRefreshError() {
    if (!_rootEl) return;

    // Remove any existing banner
    const existing = _rootEl.querySelector('.finance-refresh-error');
    if (existing) existing.remove();

    // Re-render with last good data + banner prepended
    _rootEl.innerHTML = '';

    const banner = document.createElement('div');
    banner.className = 'finance-refresh-error';
    banner.setAttribute('role', 'alert');
    banner.textContent = 'Update failed';
    _rootEl.appendChild(banner);

    // Re-render last good content below the banner
    if (_lastGoodData && !_lastGoodData.isEmpty) {
        const cardContent = _renderCard(_lastGoodData);
        _rootEl.appendChild(cardContent);
    } else {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'finance-empty';
        emptyEl.textContent = 'No finance data available';
        _rootEl.appendChild(emptyEl);
    }

    // Auto-remove banner after 10 seconds (within the 5–15s spec range)
    setTimeout(() => {
        if (banner.parentNode) {
            banner.remove();
        }
    }, 10000);
}

// --- Data fetching ---

/**
 * Resolve manifest → finance path → fetch envelope.
 * Uses AbortController with 10s timeout on manifest fetch.
 */
async function _fetchFinanceData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    _abortController = controller;

    try {
        const manifest = await _fetchManifest(controller.signal);
        const financePath = _resolveFinancePath(manifest);
        const envelope = await _fetchFinanceFile(financePath, controller.signal);
        return envelope;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetch and parse manifest.json, with fallback to ../data/manifest.json.
 */
async function _fetchManifest(signal) {
    let resp;
    try {
        resp = await fetch('data/manifest.json', { signal });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Fetch timeout');
        // Try relative fallback
        try {
            resp = await fetch('../data/manifest.json', { signal });
        } catch (err2) {
            if (err2.name === 'AbortError') throw new Error('Fetch timeout');
            throw new Error('Manifest unreachable');
        }
    }

    if (!resp || !resp.ok) {
        try {
            resp = await fetch('../data/manifest.json', { signal });
        } catch (err) {
            if (err.name === 'AbortError') throw new Error('Fetch timeout');
            throw new Error('Manifest unreachable');
        }
        if (!resp.ok) throw new Error('Manifest unreachable');
    }

    try {
        return await resp.json();
    } catch {
        throw new Error('Manifest malformed JSON');
    }
}

/**
 * Fetch the finance envelope JSON from the resolved path.
 * Includes ../path fallback for different serving roots.
 */
async function _fetchFinanceFile(path, signal) {
    let resp;
    try {
        resp = await fetch(path, { signal });
        if (!resp.ok) {
            resp = await fetch(`../${path}`, { signal });
        }
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Fetch timeout');
        try {
            resp = await fetch(`../${path}`, { signal });
        } catch (err2) {
            if (err2.name === 'AbortError') throw new Error('Fetch timeout');
            throw new Error('Finance data file unreachable');
        }
    }

    if (!resp || !resp.ok) {
        throw new Error('Finance data file unreachable');
    }

    let json;
    try {
        json = await resp.json();
    } catch {
        throw new Error('Finance data malformed JSON');
    }

    return json;
}

// --- State computation ---

/**
 * Build computed FinanceState from a fetched envelope.
 * Extracts categories, period, collected_at. Computes attention from
 * Gross Expenditures variance via _classifyVariance().
 */
function _buildState(envelope) {
    // Guard against null/undefined envelope or missing data
    if (!envelope || !envelope.data || !Array.isArray(envelope.data.categories) || envelope.data.categories.length === 0) {
        return {
            categories: [],
            totalVariancePercent: null,
            attentionLevel: 'red',
            scoreColor: null,
            period: (envelope && envelope.data && envelope.data.period) || '',
            collectedAt: (envelope && envelope.collected_at) || '',
            isEmpty: true
        };
    }

    const rawCategories = envelope.data.categories;
    const period = envelope.data.period || '';
    const collectedAt = envelope.collected_at || '';

    // Map envelope categories to state objects
    const categories = rawCategories.map(cat => ({
        name: cat.name || '',
        mtdActual: _safeNumber(cat.mtd_actual),
        budget: _safeNumber(cat.budget),
        variancePercent: _safeNumber(cat.variance_percent)
    }));

    // Find "Gross Expenditures" row for card-level attention and score
    const totalExpenses = rawCategories.find(c => c.name === 'Gross Expenditures');
    const totalVariancePercent = totalExpenses ? _safeNumber(totalExpenses.variance_percent) : null;

    // Classify attention level from Gross Expenditures variance
    const classification = _classifyVariance(totalVariancePercent);
    const attentionLevel = classification || 'red'; // Default red if unclassifiable
    const scoreColor = classification; // null means default text color

    return {
        categories,
        totalVariancePercent,
        attentionLevel,
        scoreColor,
        period,
        collectedAt,
        isEmpty: false
    };
}

/**
 * Coerce a value to a finite number or null.
 * Null, undefined, NaN, Infinity, non-number types → null.
 */
function _safeNumber(value) {
    if (value == null) return null;
    if (typeof value !== 'number') return null;
    if (!isFinite(value)) return null;
    return value;
}
