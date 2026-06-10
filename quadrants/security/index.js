/**
 * Security Quadrant Module
 *
 * Renders a data-driven table showing each ETRC group's security grade
 * and component penalty breakdown. Integrates with the shell via the
 * standard quadrant contract: init/refresh/destroy/detailUrl.
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

    // Create root element with default pre-data attention level
    _rootEl = document.createElement('div');
    _rootEl.className = 'quadrant-card';
    _rootEl.setAttribute('data-attention-level', 'yellow');

    _container.innerHTML = '';
    _container.appendChild(_rootEl);

    // Load CSS (idempotent)
    _loadCSS();

    // Fetch data, build state, render
    try {
        const envelope = await _fetchSecurityData();
        const state = _buildState(envelope);
        _lastGoodData = state;
        _applyState(state);
    } catch (err) {
        // Initial load failure — show error state, keep yellow attention
        _renderErrorState('Data unavailable');
    }
}

export async function refresh() {
    // Re-fetch data and re-render; on failure retain last good render + error banner
    try {
        const envelope = await _fetchSecurityData();
        const state = _buildState(envelope);
        _lastGoodData = state;
        _applyState(state);
    } catch (err) {
        // Retain last good render, show transient error indicator
        _showRefreshError();
    }
}

export async function destroy() {
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
 * Apply a computed SecurityState to the card DOM.
 * Sets attention-level attribute and renders either table or empty state.
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
 * Inject <link> for security.css (idempotent — keyed by element id).
 */
function _loadCSS() {
    const linkId = 'security-module-css';
    if (document.getElementById(linkId)) return;

    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = 'quadrants/security/security.css';
    document.head.appendChild(link);
}

// --- Pure utility functions ---

/**
 * Sort groups by total_score ascending (worst scores first).
 * Returns a new array - does not mutate the input.
 */
export function _sortGroups(groups) {
    return [...groups].sort((a, b) => a.total_score - b.total_score);
}

/**
 * Determine card attention level from group grades.
 * Any D or F -> "red". Any C (rest A/B) -> "yellow". All A/B -> "green".
 */
export function _classifyAttentionLevel(groups) {
    const grades = groups.map(g => g.grade);
    if (grades.some(g => g === 'D' || g === 'F')) return 'red';
    if (grades.some(g => g === 'C')) return 'yellow';
    return 'green';
}

/**
 * Map a grade letter to its CSS text-color class name.
 * Uses grade-text-{x} to apply colored text (not background).
 */
export function _gradeToClass(grade) {
    return `grade-text-${grade.toLowerCase()}`;
}

/**
 * Format a penalty value for table display.
 * Zero -> "0". Non-zero -> sign + one decimal.
 */
export function _formatPenalty(value) {
    if (value === 0) return '0';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}`;
}

/**
 * Format a collected_at ISO timestamp into the display label.
 * Uses UTC date components to avoid timezone drift.
 */
export function _formatCollectedDate(isoString) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const date = new Date(isoString);
    const month = months[date.getUTCMonth()];
    const day = date.getUTCDate();
    const year = date.getUTCFullYear();
    return `as of ${month} ${day}, ${year}`;
}

/**
 * Extract the security data file path from a parsed manifest object.
 * Throws if the path is missing, null, or empty string.
 */
export function _resolveSecurityPath(manifest) {
    if (!manifest || !manifest.collectors || !manifest.collectors.security) {
        throw new Error('Security entry missing from manifest');
    }
    const latest = manifest.collectors.security.latest;
    if (!latest || typeof latest !== 'string' || latest.trim() === '') {
        throw new Error('Security latest path missing from manifest');
    }
    return latest;
}

// --- Rendering functions ---

/**
 * Render the full security card DOM from computed SecurityState.
 * All DOM built via createElement - no innerHTML with dynamic data.
 *
 * Rendering order:
 * 1. Hero section (WGU aggregate score + grade + status badge)
 * 2. Sparkline (14-day WGU score trend)
 * 3. Card header (module title + timestamp)
 * 4. Team breakdown table
 */
export function _renderCard(state) {
    const card = document.createElement('div');
    card.className = 'security-card-content';

    // --- Hero zone: fixed-height region above the table (matches ops hero-zone) ---
    const heroZone = document.createElement('div');
    heroZone.className = 'security-hero-zone';

    if (state.wguScore != null) {
        // WGU aggregate: colored grade letter + score + status pill
        const heroGroup = document.createElement('div');
        heroGroup.className = 'security-hero';

        // Grade letter — large, colored, no box
        const gradeEl = document.createElement('span');
        gradeEl.className = `security-wgu-grade ${_gradeToClass(state.wguGrade)}`;
        gradeEl.textContent = state.wguGrade;
        heroGroup.appendChild(gradeEl);

        // Score number
        const scoreEl = document.createElement('span');
        scoreEl.className = 'security-wgu-score';
        scoreEl.textContent = state.wguScore.toFixed(1);
        heroGroup.appendChild(scoreEl);

        // Status pill box: Healthy / At Risk / Critical
        const badge = document.createElement('span');
        const severity = _gradeToSeverity(state.wguGrade);
        badge.className = 'ops-status-badge';
        badge.setAttribute('data-severity', severity);
        badge.textContent = _gradeToStatusLabel(state.wguGrade);
        heroGroup.appendChild(badge);

        heroZone.appendChild(heroGroup);

        // Label: "WGU Security Score"
        const label = document.createElement('span');
        label.className = 'security-wgu-label';
        label.textContent = 'WGU Security Score';
        heroZone.appendChild(label);
    }

    const timestamp = document.createElement('span');
    timestamp.className = 'security-timestamp';
    timestamp.textContent = _formatCollectedDate(state.collectedAt);
    heroZone.appendChild(timestamp);

    // Sparkline fills remaining space in hero zone (when data available)
    // Shows empty blue box when no data — matches ops treatment
    if (state.wguHistory && state.wguHistory.length >= 2) {
        const sparkline = _renderSparkline(state.wguHistory);
        heroZone.appendChild(sparkline);
    } else {
        const emptySparkline = document.createElement('div');
        emptySparkline.className = 'security-sparkline security-sparkline-empty';
        heroZone.appendChild(emptySparkline);
    }

    card.appendChild(heroZone);

    // Build semantic table
    const table = document.createElement('table');
    table.className = 'security-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const columns = ['Function', 'Grade', 'Vuln', 'Audit', 'Excp', 'Incidents'];

    for (const col of columns) {
        const th = document.createElement('th');
        th.className = 'security-th';
        th.textContent = col;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body: one row per group in sorted order
    const tbody = document.createElement('tbody');
    const penaltyKeys = ['Vulnerability', 'Audit', 'Exceptions', 'Incidents'];

    for (const group of state.groups) {
        const row = document.createElement('tr');

        const nameCell = document.createElement('td');
        nameCell.className = 'security-td';
        nameCell.textContent = group.groupName;
        row.appendChild(nameCell);

        const gradeCell = document.createElement('td');
        gradeCell.className = `security-td security-grade ${_gradeToClass(group.grade)}`;
        gradeCell.textContent = group.grade;
        row.appendChild(gradeCell);

        for (const key of penaltyKeys) {
            const penaltyValue = group.penalties[key] || 0;
            const cell = document.createElement('td');
            const penaltyClass = penaltyValue === 0 ? 'penalty-zero' : 'penalty-active';
            cell.className = `security-td ${penaltyClass}`;
            cell.textContent = _formatPenalty(penaltyValue);
            row.appendChild(cell);
        }
        tbody.appendChild(row);
    }

    table.appendChild(tbody);
    card.appendChild(table);
    return card;
}

// --- Hero and Sparkline rendering ---

/**
 * Render the WGU aggregate hero section: large score, grade badge, status label.
 * Mirrors the operations quadrant's FSI hero pattern.
 */
function _renderHero(state) {
    const hero = document.createElement('div');
    hero.className = 'security-hero';

    // Large score number
    const scoreEl = document.createElement('span');
    scoreEl.className = 'security-wgu-score';
    scoreEl.textContent = state.wguScore.toFixed(1);
    hero.appendChild(scoreEl);

    // Grade letter (colored by grade class)
    const gradeEl = document.createElement('span');
    gradeEl.className = `security-wgu-grade ${_gradeToClass(state.wguGrade)}`;
    gradeEl.textContent = state.wguGrade;
    hero.appendChild(gradeEl);

    // Status badge: A/B = Healthy green, C = At Risk yellow, D/F = Critical red
    const badge = document.createElement('span');
    const severity = _gradeToSeverity(state.wguGrade);
    badge.className = 'ops-status-badge';
    badge.setAttribute('data-severity', severity);
    badge.textContent = _gradeToStatusLabel(state.wguGrade);
    hero.appendChild(badge);

    // Label below the hero row
    const label = document.createElement('span');
    label.className = 'security-wgu-label';
    label.textContent = 'WGU Security Score \u2014 higher is better';
    hero.appendChild(label);

    return hero;
}

/**
 * Map a grade letter to severity for the status badge color.
 */
function _gradeToSeverity(grade) {
    if (grade === 'A' || grade === 'B') return 'green';
    if (grade === 'C') return 'amber';
    return 'red';
}

/**
 * Map a grade letter to the status badge text label.
 */
function _gradeToStatusLabel(grade) {
    if (grade === 'A' || grade === 'B') return 'Healthy';
    if (grade === 'C') return 'At Risk';
    return 'Critical';
}

/**
 * Render SVG sparkline from WGU aggregate score history.
 * Higher scores render higher on the Y axis (inverted from ops FSI where lower is better).
 * Minimum 2 points required to draw a line.
 */
export function _renderSparkline(history) {
    const container = document.createElement('div');
    container.className = 'security-sparkline';

    if (!history || history.length < 2) {
        // Empty sparkline box — same treatment as ops
        container.classList.add('security-sparkline-empty');
        return container;
    }

    const scores = history.map(h => h.score);

    // If all scores are the same (flat line), show empty box instead
    const allSame = scores.every(s => s === scores[0]);
    if (allSame) {
        container.classList.add('security-sparkline-empty');
        return container;
    }
    const width = 200;
    const height = 48;
    const padding = 4;
    const drawWidth = width - (padding * 2);
    const drawHeight = height - (padding * 2);

    // Normalize scores to SVG coordinates — higher scores should be HIGHER (lower Y)
    const maxScore = Math.max(...scores, 5);
    const minScore = Math.min(...scores, 0);
    const range = maxScore - minScore || 1;

    const points = scores.map((score, i) => {
        const x = padding + (i / (scores.length - 1)) * drawWidth;
        // Higher score = lower Y (top of chart) — inverted from ops
        const y = padding + ((maxScore - score) / range) * drawHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', 'WGU security score trend');

    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', points.join(' '));
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', 'var(--accent)');
    polyline.setAttribute('stroke-width', '1.5');
    polyline.setAttribute('stroke-linecap', 'round');
    polyline.setAttribute('stroke-linejoin', 'round');

    svg.appendChild(polyline);
    container.appendChild(svg);
    return container;
}

// --- Error and empty state rendering ---

/**
 * Render an error state into the root element when initial load fails.
 * Replaces all content with a centered warning icon and message.
 */
export function _renderErrorState(message) {
    if (!_rootEl) return;

    _rootEl.innerHTML = '';

    const errorEl = document.createElement('div');
    errorEl.className = 'security-error';
    errorEl.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'security-error-icon';
    icon.textContent = '\u26A0\uFE0F';
    errorEl.appendChild(icon);

    const msg = document.createElement('span');
    msg.className = 'security-error-message';
    msg.textContent = message;
    errorEl.appendChild(msg);

    _rootEl.appendChild(errorEl);
}

/**
 * Show refresh error indicator while retaining last good table content.
 * Prepends a yellow "Update failed" banner above the existing table.
 * If no prior successful render exists, falls back to full error state.
 */
export function _showRefreshError() {
    if (!_rootEl) return;

    const existing = _rootEl.querySelector('.security-refresh-error');
    if (existing) existing.remove();

    if (_lastGoodData) {
        _rootEl.innerHTML = '';

        const errorBanner = document.createElement('div');
        errorBanner.className = 'security-refresh-error';
        errorBanner.setAttribute('role', 'alert');
        errorBanner.textContent = 'Update failed';
        _rootEl.appendChild(errorBanner);

        if (_lastGoodData.isEmpty) {
            const emptyEl = _renderEmptyState();
            _rootEl.appendChild(emptyEl);
        } else {
            const cardContent = _renderCard(_lastGoodData);
            _rootEl.appendChild(cardContent);
        }
    } else {
        _renderErrorState('Data unavailable');
    }
}

/**
 * Render the empty groups state - a centered indicator when the
 * security envelope contains no ETRC groups to display.
 */
export function _renderEmptyState() {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'security-empty';
    emptyEl.setAttribute('role', 'alert');
    emptyEl.textContent = 'No security data';
    return emptyEl;
}

// --- Data fetching ---

/**
 * Resolve manifest -> security path -> fetch envelope.
 * Uses AbortController with 10s timeout.
 */
export async function _fetchSecurityData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    _abortController = controller;

    try {
        const manifest = await _fetchManifest(controller.signal);
        const securityPath = _resolveSecurityPath(manifest);
        const envelope = await _fetchSecurityFile(securityPath, controller.signal);
        return envelope;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function _fetchManifest(signal) {
    let resp;
    try {
        resp = await fetch('data/manifest.json', { signal });
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Fetch timeout');
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

async function _fetchSecurityFile(path, signal) {
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
            throw new Error('Security data file unreachable');
        }
    }

    if (!resp || !resp.ok) {
        throw new Error('Security data file unreachable');
    }

    let json;
    try {
        json = await resp.json();
    } catch {
        throw new Error('Security data malformed JSON');
    }

    if (!json.data || !Array.isArray(json.data.groups)) {
        throw new Error('Security data missing data.groups array');
    }

    return json;
}

// --- State computation ---

/**
 * Build computed SecurityState from a fetched envelope.
 */
export function _buildState(envelope) {
    const rawGroups = envelope.data.groups;
    const collectedAt = envelope.collected_at || envelope.data.metadata?.collected_at || '';

    // WGU aggregate data (optional — backward compat if missing)
    const wguAggregate = envelope.data.wgu_aggregate || null;
    const wguScore = wguAggregate?.total_score ?? null;
    const wguGrade = wguAggregate?.grade ?? null;
    const wguHistory = wguAggregate?.history ?? [];
    const wguComponents = wguAggregate?.components ?? [];

    if (!rawGroups || rawGroups.length === 0) {
        return {
            groups: [],
            attentionLevel: 'yellow',
            collectedAt,
            isEmpty: true,
            wguScore,
            wguGrade,
            wguHistory,
            wguComponents
        };
    }

    const sorted = _sortGroups(rawGroups);
    const attentionLevel = _classifyAttentionLevel(sorted);

    const groups = sorted.map(group => ({
        groupName: group.group_name,
        grade: group.grade,
        totalScore: group.total_score,
        penalties: _buildPenaltiesMap(group.components)
    }));

    return {
        groups,
        attentionLevel,
        collectedAt,
        isEmpty: false,
        wguScore,
        wguGrade,
        wguHistory,
        wguComponents
    };
}

function _buildPenaltiesMap(components) {
    if (!components || !Array.isArray(components)) return {};
    const penalties = {};
    for (const comp of components) {
        penalties[comp.name] = comp.penalty;
    }
    return penalties;
}
