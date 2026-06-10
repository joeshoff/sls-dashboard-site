/**
 * Operations Quadrant Module — Summary View
 *
 * Renders FSI composite score with status badge, sparkline of historical
 * scores, and function-row table (ETRC grade, FSI attribution, Sev 1-2 MI count).
 *
 * Imports transforms from the shared operations-transforms.js — no reimplementation.
 * Click-through navigates to the existing operations detail view.
 */

import {
    classifyFSIScore,
    gradeToColor,
    sortETRCRows,
    computeFSITrend,
    parseSeverity
} from '../../js/operations-transforms.js';

// --- Module state ---
let _container = null;
let _rootEl = null;
let _lastGoodData = null;
let _abortController = null;

export const detailUrl = 'operations.html';

// --- Public contract ---

export async function init(containerElement) {
    // Re-initialization: clear previous container without throwing
    if (_container && _container !== containerElement) {
        _container.innerHTML = '';
    }

    _container = containerElement;
    _container.innerHTML = '';

    // Inject module-specific CSS if not already loaded
    _loadCSS();

    // Attempt to load data and render — catch any errors to prevent
    // the shell from treating this as a failed module
    try {
        const data = await _fetchAllData();
        _render(data);
    } catch (err) {
        console.error('Operations quadrant init error:', err);
        // Render error state rather than rejecting the promise
        _render(null);
    }
}

/**
 * Inject the operations quadrant CSS stylesheet into the document head.
 * Idempotent — won't add duplicate links.
 */
function _loadCSS() {
    const cssId = 'ops-quadrant-css';
    if (document.getElementById(cssId)) return;

    const link = document.createElement('link');
    link.id = cssId;
    link.rel = 'stylesheet';
    link.href = 'quadrants/operations/operations.css';
    document.head.appendChild(link);
}

export async function refresh() {
    if (!_container) return;

    try {
        const data = await _fetchAllData();
        _render(data);
    } catch (err) {
        // On failure: show error indicator, retain last good state
        _showErrorIndicator();
    }
}

export async function destroy() {
    // Cancel any pending fetches
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

// --- Data fetching (6.9) ---

/**
 * Fetch manifest, resolve paths, load FSI/ETRC/historical data.
 * Graceful partial-data handling at every step.
 */
async function _fetchAllData() {
    _abortController = new AbortController();
    const signal = _abortController.signal;

    // Step 1: Resolve manifest for current file paths
    const manifest = await _fetchManifest(signal);

    // Step 2: Load FSI, ETRC, incidents, and historical data concurrently
    const [fsiData, etrcData, incidentData, historicalScores] = await Promise.all([
        _fetchFSI(manifest, signal),
        _fetchETRC(manifest, signal),
        _fetchIncidents(manifest, signal),
        _fetchHistoricalFSI(manifest, signal)
    ]);

    // Step 3: Build the OpsQuadrantData object
    return _buildQuadrantData(fsiData, etrcData, incidentData, historicalScores);
}

async function _fetchManifest(signal) {
    try {
        // Try paths in priority order:
        // 1. data/manifest.json (serving from frontend/ with symlink, or flat deployment)
        // 2. ../data/manifest.json (serving from project root, page at frontend/index.html)
        let resp = await fetch('data/manifest.json', { signal });
        if (!resp.ok) {
            resp = await fetch('../data/manifest.json', { signal });
        }
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        // Manifest unreachable: fall back to conventional path derivation
        return null;
    }
}

async function _fetchFSI(manifest, signal) {
    const path = _resolvePath(manifest, 'fsi');
    if (!path) return null;

    try {
        // Try without ../ prefix first (serving from frontend/), then with (serving from root)
        let resp = await fetch(path, { signal });
        if (!resp.ok) {
            resp = await fetch(`../${path}`, { signal });
        }
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

async function _fetchETRC(manifest, signal) {
    const path = _resolvePath(manifest, 'etrc');
    if (!path) return null;

    try {
        // Try without ../ prefix first (serving from frontend/), then with (serving from root)
        let resp = await fetch(path, { signal });
        if (!resp.ok) {
            resp = await fetch(`../${path}`, { signal });
        }
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

async function _fetchIncidents(manifest, signal) {
    const path = _resolvePath(manifest, 'incidents');
    if (!path) return null;

    try {
        let resp = await fetch(path, { signal });
        if (!resp.ok) {
            resp = await fetch(`../${path}`, { signal });
        }
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

/**
 * Load historical FSI files to build sparkline data.
 * Attempts conventional path derivation for the last 12 weeks.
 */
async function _fetchHistoricalFSI(manifest, signal) {
    const scores = [];
    const now = new Date();

    // Generate paths for the last 12 weeks
    for (let i = 0; i < 12; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - (i * 7));
        const dateStr = d.toISOString().split('T')[0];

        // Try both path forms (with and without ../ prefix)
        const paths = [
            `data/fsi/fsi_${dateStr}.json`,
            `../data/fsi/fsi_${dateStr}.json`
        ];

        for (const path of paths) {
            try {
                const resp = await fetch(path, { signal });
                if (resp.ok) {
                    const json = await resp.json();
                    const score = json?.data?.composite?.score;
                    if (score != null) {
                        scores.push({ date: dateStr, score });
                    }
                    break; // Found it, move to next week
                }
            } catch {
                // Try next path variant
            }
        }
    }

    // Return oldest-first for sparkline rendering
    return scores.reverse();
}

/**
 * Resolve file path from manifest, falling back to conventional derivation.
 */
function _resolvePath(manifest, collectorName) {
    // Try manifest first
    if (manifest?.collectors?.[collectorName]?.latest) {
        return manifest.collectors[collectorName].latest;
    }

    // Fallback: derive path from current date
    const now = new Date();
    // Step back to last Sunday for conventional weekly files
    const dayOfWeek = now.getDay();
    const daysSinceSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
    const lastSunday = new Date(now);
    lastSunday.setDate(now.getDate() - daysSinceSunday);
    const dateStr = lastSunday.toISOString().split('T')[0];

    return `data/${collectorName}/${collectorName}_${dateStr}.json`;
}

// --- Data transformation ---

/**
 * Build the OpsQuadrantData model from raw fetched data.
 * Handles partial data gracefully — null fields where data is unavailable.
 */
function _buildQuadrantData(fsiData, etrcData, incidentData, historicalScores) {
    // FSI composite score and classification
    const fsiComposite = fsiData?.data?.composite?.score ?? null;
    const fsiStatus = fsiComposite != null ? classifyFSIScore(fsiComposite) : null;

    // Historical scores for sparkline
    const fsiHistory = historicalScores.map(h => h.score);

    // FSI trend: compare latest to prior score
    const priorScore = fsiHistory.length >= 2 ? fsiHistory[fsiHistory.length - 2] : null;
    const fsiTrend = fsiComposite != null ? computeFSITrend(fsiComposite, priorScore) : null;

    // SLS-wide ETRC grade from the aggregate group
    const slsOverall = etrcData?.data?.sls_overall ?? null;
    const slsGrade = slsOverall?.grade ?? null;
    const slsScore = slsOverall?.total_score ?? null;

    // Function rows from ETRC data + MI counts from incident data
    const functionRows = _buildFunctionRows(etrcData, incidentData);

    return {
        fsiComposite,
        fsiStatus,
        fsiHistory,
        fsiTrend,
        slsGrade,
        slsScore,
        functionRows
    };
}

/**
 * Build sorted function rows from ETRC groups.
 * Each row: semName, grade, miCount (Sev 1-2 MIs for that group).
 */
function _buildFunctionRows(etrcData, incidentData) {
    const groups = etrcData?.data?.groups;
    if (!groups || groups.length === 0) return [];

    // Build a map of group_sys_id → Sev 1-2 MI count from incident data
    const miCountsByGroup = _countMIsByGroup(incidentData);

    const rows = groups.map(group => ({
        semName: group.group_name,
        grade: group.grade || null,
        miCount: miCountsByGroup[group.group_sys_id] || 0
    }));

    return sortETRCRows(rows);
}

/**
 * Count Sev 1-2 Major Incidents per ETRC group from the incidents collector data.
 * Returns a map of group_sys_id → count.
 */
function _countMIsByGroup(incidentData) {
    const counts = {};
    const mis = incidentData?.data?.major_incidents;
    if (!mis || !Array.isArray(mis)) return counts;

    for (const mi of mis) {
        // Skip retracted MIs (Closed/Cancelled = false alarm, not a real incident)
        if (mi.state === 'Closed/Cancelled') continue;
        const sev = parseSeverity(mi.priority);
        // Only count Sev 1 and Sev 2
        if (sev >= 1 && sev <= 2 && mi.group_sys_id) {
            counts[mi.group_sys_id] = (counts[mi.group_sys_id] || 0) + 1;
        }
    }
    return counts;
}

// --- Rendering ---

/**
 * Render the full operations quadrant card.
 * Handles all partial-data states gracefully.
 */
function _render(data) {
    if (!_container) return;

    // Determine attention level from worst ETRC group grade (not FSI aggregate)
    const attentionLevel = _getWorstGradeAttention(data?.functionRows);

    // Build root element
    _rootEl = document.createElement('div');
    _rootEl.className = 'quadrant-card';
    _rootEl.setAttribute('data-attention-level', attentionLevel);

    if (data == null || (data?.fsiComposite == null && data?.slsGrade == null && (!data?.functionRows || data.functionRows.length === 0))) {
        // All data failed — render error state
        _rootEl.setAttribute('data-attention-level', 'red');
        _rootEl.innerHTML = `
            <div class="ops-error-state">
                <span class="ops-error-icon">⚠️</span>
                <span class="ops-error-message">Data unavailable</span>
            </div>
        `;

        // Retain last good state if available
        if (_lastGoodData) {
            _renderContent(_rootEl, _lastGoodData);
        }
    } else {
        // Successful render — store as last good state
        _lastGoodData = data;
        _renderContent(_rootEl, data);
    }

    _container.innerHTML = '';
    _container.appendChild(_rootEl);
}

/**
 * Render the actual content: SLS ETRC hero grade, FSI score, sparkline, function rows.
 */
function _renderContent(rootEl, data) {
    let html = '';

    // Hero zone: fixed-height region containing SLS ETRC grade + FSI score + sparkline.
    // Height locked via CSS so the table always starts at the same position.
    html += '<div class="ops-hero-zone">';
    html += _renderHeroRow(data);
    html += _renderSparkline(data.fsiHistory);
    html += '</div>';

    // Function-row table
    html += _renderFunctionTable(data.functionRows);

    rootEl.innerHTML = html;
}

/**
 * Render the hero row: SLS ETRC grade on the left, FSI score on the right.
 * SLS ETRC grade uses the same color rules as the table grades.
 * FSI score displays with its status badge and trend indicator.
 */
function _renderHeroRow(data) {
    // SLS ETRC grade — primary hero element
    const slsGradeDisplay = data.slsGrade || '—';
    const slsGradeColor = data.slsGrade ? gradeToColor(data.slsGrade) : null;
    const slsGradeStyle = slsGradeColor ? `style="color: ${slsGradeColor}"` : '';

    // FSI score — secondary, positioned to the right
    let fsiHtml = '';
    if (data.fsiComposite != null) {
        const trendHtml = data.fsiTrend ? `
            <span class="ops-fsi-trend" data-direction="${data.fsiTrend.direction}">
                ${data.fsiTrend.label}
            </span>
        ` : '';

        fsiHtml = `
            <div class="ops-fsi-compact">
                <span class="ops-fsi-score-sm">${data.fsiComposite}</span>
                <span class="ops-status-badge" data-severity="${data.fsiStatus.severity}">
                    ${data.fsiStatus.status}
                </span>
                ${trendHtml}
                <span class="ops-fsi-label-inline">FSI</span>
            </div>
        `;
    } else {
        fsiHtml = `
            <div class="ops-fsi-compact">
                <span class="ops-fsi-score-sm ops-fsi-unavailable">—</span>
                <span class="ops-fsi-label-inline">FSI</span>
            </div>
        `;
    }

    return `
        <div class="ops-hero-row">
            <div class="ops-etrc-hero">
                <span class="ops-etrc-grade" ${slsGradeStyle}>${slsGradeDisplay}</span>
                <span class="ops-etrc-label">SLS ETRC</span>
            </div>
            ${fsiHtml}
        </div>
    `;
}

/**
 * Render SVG sparkline from historical FSI scores.
 * Minimum 2 points to draw a line; renders empty state otherwise.
 */
function _renderSparkline(fsiHistory) {
    if (!fsiHistory || fsiHistory.length < 2) {
        return '<div class="ops-sparkline ops-sparkline-empty"></div>';
    }

    const width = 200;
    const height = 40;
    const padding = 4;
    const drawWidth = width - (padding * 2);
    const drawHeight = height - (padding * 2);

    // Normalize scores to SVG coordinates
    const maxScore = Math.max(...fsiHistory, 1);
    const minScore = Math.min(...fsiHistory, 0);
    const range = maxScore - minScore || 1;

    const points = fsiHistory.map((score, i) => {
        const x = padding + (i / (fsiHistory.length - 1)) * drawWidth;
        // Invert Y — lower scores are better, should render higher
        const y = padding + ((score - minScore) / range) * drawHeight;
        return `${x},${y}`;
    });

    const pointCount = fsiHistory.length;

    return `
        <div class="ops-sparkline" data-points="${pointCount}">
            <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="FSI score trend">
                <polyline
                    points="${points.join(' ')}"
                    fill="none"
                    stroke="var(--accent)"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
        </div>
    `;
}

/**
 * Render the function-row table showing ETRC grade, FSI attribution, MI count.
 * Rows are already sorted worst-first via sortETRCRows.
 */
function _renderFunctionTable(functionRows) {
    if (!functionRows || functionRows.length === 0) {
        return '<div class="ops-fn-table ops-fn-empty"></div>';
    }

    const rowsHtml = functionRows.map(row => {
        const gradeColor = row.grade ? gradeToColor(row.grade) : null;
        const gradeDisplay = row.grade || '—';
        const gradeStyle = gradeColor ? `style="color: ${gradeColor}"` : '';
        const miDisplay = row.miCount > 0 ? row.miCount : '0';

        return `
            <tr class="ops-fn-row">
                <td class="ops-fn-name">${row.semName}</td>
                <td class="ops-fn-grade" ${gradeStyle}>${gradeDisplay}</td>
                <td class="ops-fn-mi-count">${miDisplay}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="ops-fn-table">
            <table>
                <thead>
                    <tr>
                        <th>Function</th>
                        <th style="text-align: center">Grade</th>
                        <th style="text-align: center">MI 1-2</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
}

// --- Error handling ---

/**
 * Show error indicator on refresh failure without destroying last good content.
 */
function _showErrorIndicator() {
    if (!_rootEl) return;

    // Add error indicator if not already present
    if (!_rootEl.querySelector('.ops-refresh-error')) {
        const indicator = document.createElement('div');
        indicator.className = 'ops-refresh-error';
        indicator.setAttribute('role', 'alert');
        indicator.textContent = 'Update failed';
        _rootEl.prepend(indicator);
    }

    // Set attention level to yellow on refresh failure
    _rootEl.setAttribute('data-attention-level', 'yellow');
}

// --- Utility ---

/**
 * Map FSI severity (green/amber/red) to attention-level (green/yellow/red).
 * Amber maps to yellow per design spec.
 */
function _mapSeverityToAttention(severity) {
    switch (severity) {
        case 'green': return 'green';
        case 'amber': return 'yellow';
        case 'red': return 'red';
        default: return 'green';
    }
}

/**
 * Determine card attention level from the worst ETRC group grade.
 * Any D/F → red, any C → yellow, all A/B → green.
 * Falls back to green if no function rows exist.
 */
function _getWorstGradeAttention(functionRows) {
    if (!functionRows || functionRows.length === 0) return 'green';
    const grades = functionRows.map(r => r.grade).filter(Boolean);
    if (grades.some(g => g === 'D' || g === 'F')) return 'red';
    if (grades.some(g => g === 'C')) return 'yellow';
    return 'green';
}
