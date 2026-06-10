/**
 * vp-operations.js — VP-level operations view section renderers.
 *
 * Renders the full operations picture: FSI composite with trend,
 * FSI pillar breakdown, ETRC team scores, weekly Major Incidents,
 * and incident volume/MTTR trends.
 *
 * Each section renders independently inside a try/catch — a failure
 * in one section doesn't cascade to the others.
 *
 * Exported entry point: renderVPView(container, context)
 * Called by operations-router.js via dynamic import.
 */

import {
    classifyFSIScore,
    computePillarContributions,
    computeFSITrend,
    gradeToColor,
    bucketMIsBySeverity,
    filterBySeverity,
    bucketIncidentsByWeek,
    isStale,
    findOldestTimestamp,
    buildMIUrl
} from './operations-transforms.js';

import {
    buildFSITrendChart,
    buildIncidentTrendChart
} from './operations-charts.js';

// ─── ECharts Instance Tracking ───────────────────────────────────────────────

// Track all chart instances for debounced resize (same pattern as team view)
const chartInstances = [];
let resizeTimer = null;
let resizeListenerAttached = false;

/**
 * Register a chart instance for debounced resize handling.
 * Sets up a single window resize listener on first call.
 * Debounce at 200ms satisfies the 300ms re-render requirement (Req 12.4).
 */
function registerChart(chart) {
    chartInstances.push(chart);
    if (!resizeListenerAttached) {
        resizeListenerAttached = true;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                chartInstances.forEach(c => {
                    if (!c.isDisposed()) c.resize();
                });
            }, 200);
        });
    }
}

/**
 * Clear the chart registry. Called before re-rendering to prevent stale references.
 */
export function clearChartRegistry() {
    chartInstances.length = 0;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Render a section-level error message.
 * Used when a data source is unavailable or rendering fails.
 */
function renderSectionError(sourceName, reason) {
    const messages = {
        not_configured: `${sourceName} data source not configured`,
        fetch_failed: `${sourceName} data unavailable — could not reach data source`,
        render_failed: `${sourceName} display error — data may be malformed`
    };
    return `<div class="section-error"><span class="error-icon">⚠</span> ${messages[reason] || `${sourceName} unavailable`}</div>`;
}

/**
 * Render a warning banner when an envelope has non-empty errors array.
 * Partial data may still be rendered below this warning.
 */
function renderEnvelopeWarning(envelope) {
    if (!envelope || !envelope.errors || envelope.errors.length === 0) return '';
    const count = envelope.errors.length;
    return `<div class="section-warning">⚠ Data may be incomplete (${count} error${count > 1 ? 's' : ''} reported)</div>`;
}

/**
 * Escape HTML to prevent XSS from data values.
 */
function escapeHTML(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Truncate a string to maxLen characters, appending ellipsis if truncated.
 */
function truncate(str, maxLen = 120) {
    if (!str || str.length <= maxLen) return str || '';
    return str.slice(0, maxLen) + '…';
}

/**
 * Format a duration between two ISO timestamps as human-readable.
 * Returns "Open" if resolvedAt is null.
 */
function formatDuration(openedAt, resolvedAt) {
    if (!resolvedAt) return 'Open';
    const ms = new Date(resolvedAt) - new Date(openedAt);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
}

/**
 * Build FSI trend data points from historical envelopes + current score.
 * Each historical envelope has data.composite.score and data.metadata.week_ending.
 * Appends the current week's score as the last point.
 */
function buildFSITrendData(historicalFSI, currentScore, currentWeekEnding) {
    const points = [];

    // Extract from historical envelopes (oldest first — they're loaded that way)
    for (const envelope of historicalFSI) {
        if (envelope && envelope.data && envelope.data.composite && envelope.data.metadata) {
            points.push({
                weekEnding: envelope.data.metadata.week_ending,
                score: envelope.data.composite.score
            });
        }
    }

    // Add current week as the last point
    if (currentScore != null && currentWeekEnding) {
        points.push({ weekEnding: currentWeekEnding, score: currentScore });
    }

    return points;
}

/**
 * Format the actual metric value for a pillar card headline.
 * Shows the human-readable metric (percentage, apdex, seconds) rather than
 * the FSI score, which is unintuitive (0 = perfect confuses people).
 */
function formatPillarActualValue(pillarName, rawPillar) {
    if (!rawPillar || typeof rawPillar !== 'object') return '—';

    switch (pillarName.toLowerCase()) {
        case 'availability':
            // Show uptime percentage
            return rawPillar.actual_pct != null ? `${rawPillar.actual_pct}%` : '—';
        case 'sessions':
            // Primary metric: session count (volume). Matches FSI board pattern.
            // Falls back to Apdex if session_count not yet available from collector.
            if (rawPillar.session_count != null) {
                return formatSessionCount(rawPillar.session_count);
            }
            return rawPillar.apdex != null ? `Apdex ${rawPillar.apdex}` : '—';
        case 'performance':
            // Show average page load time if available
            return rawPillar.avg_load_time != null ? `${rawPillar.avg_load_time}s avg` : `Score ${rawPillar.score}`;
        case 'incidents':
            // Show total count as headline; severity breakdown rendered separately below
            if (rawPillar.total_count != null) {
                return `${rawPillar.total_count}`;
            }
            return rawPillar.score != null ? `Score ${rawPillar.score}` : '—';
        default:
            return rawPillar.score != null ? `${rawPillar.score}` : '—';
    }
}

/**
 * Format a raw session count into a human-readable abbreviated form.
 * e.g., 910000 → "0.91M", 1500000 → "1.5M", 45000 → "45K"
 */
function formatSessionCount(count) {
    if (count >= 1_000_000) {
        const millions = count / 1_000_000;
        // Show 2 decimal places for < 10M, 1 for >= 10M
        const formatted = millions < 10
            ? millions.toFixed(2).replace(/\.?0+$/, '')
            : millions.toFixed(1).replace(/\.?0+$/, '');
        return `${formatted}M`;
    }
    if (count >= 1_000) {
        const thousands = count / 1_000;
        const formatted = thousands < 10
            ? thousands.toFixed(1).replace(/\.?0+$/, '')
            : Math.round(thousands).toString();
        return `${formatted}K`;
    }
    return count.toString();
}

/**
 * Format a collected_at timestamp for display.
 */
function formatTimestamp(isoString) {
    if (!isoString) return 'Unknown';
    const d = new Date(isoString);
    const options = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
    return d.toLocaleString('en-US', options);
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Render the VP-level operations view.
 * Sets up the page structure with header and 5 section containers,
 * then calls each section renderer independently.
 */
export function renderVPView(container, context) {
    // Clear chart registry before re-rendering (prevents stale references on refresh)
    clearChartRegistry();

    // Build the page skeleton — header + section containers
    container.innerHTML = `
        <div class="ops-header">
            <a href="index.html" class="back-link">← Executive Dashboard</a>
            <h1>Operations</h1>
            <div class="last-updated" id="globalTimestamp"></div>
        </div>
        <div class="ops-hero-row">
            <div id="fsi-composite-section" class="ops-hero-panel"></div>
            <div id="etrc-scores-section" class="ops-hero-panel"></div>
        </div>
        <div id="fsi-pillars-section" class="ops-section"></div>
        <div id="insights-section" class="ops-section"></div>
        <div id="mi-weekly-section" class="ops-section"></div>
        <div id="incident-trends-section" class="ops-section"></div>
    `;

    // Render each section independently — errors are contained
    renderFSIComposite(context);
    renderFSIPillars(context);
    renderETRCScores(context);
    renderInsights(context);
    renderWeeklyMIs(context);
    renderIncidentTrends(context);
    renderGlobalTimestamp(context);
}

// ─── Section Renderers ───────────────────────────────────────────────────────

/**
 * FSI Composite section: score, status badge, trend indicator, 12-week chart.
 */
function renderFSIComposite(context) {
    const section = document.getElementById('fsi-composite-section');
    try {
        const { fsiData, historical } = context;

        if (!fsiData.available) {
            section.innerHTML = renderSectionError('FSI', fsiData.reason);
            return;
        }

        const envelope = fsiData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const { composite } = envelope.data;
        const weekEnding = envelope.data.metadata.week_ending;
        const classification = classifyFSIScore(composite.score);

        // Build trend data from historical + current
        const trendData = buildFSITrendData(historical.fsi, composite.score, weekEnding);

        // Compute week-over-week trend (need at least 2 points)
        const trend = trendData.length >= 2
            ? computeFSITrend(composite.score, trendData[trendData.length - 2].score)
            : null;

        // Determine trend arrow
        let trendHTML = '';
        if (trend) {
            const arrow = trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→';
            trendHTML = `<span class="fsi-trend ${trend.direction}">${trend.label} ${arrow}</span>`;
        }

        // Determine chart HTML — need at least 2 points for a line
        let chartHTML = '';
        if (trendData.length >= 2) {
            chartHTML = `<div class="fsi-chart-container" id="fsi-trend-chart"></div>`;
        } else if (trendData.length === 1) {
            chartHTML = `<div class="empty-state">Trend data requires at least 2 weekly collections</div>`;
        }

        // Build FSI status legend — highlight the chip matching current classification
        const activeStatus = classification.status.toLowerCase();
        const legendStatuses = ['optimal', 'stable', 'elevated', 'severe', 'systemic'];
        const legendLabels = { optimal: 'Optimal (0-10)', stable: 'Stable (11-25)', elevated: 'Elevated (26-40)', severe: 'Severe (41-60)', systemic: 'Systemic (61+)' };
        const legendHTML = legendStatuses.map(s => {
            const activeClass = s === activeStatus ? ' active' : '';
            return `<span class="fsi-legend-chip ${s}${activeClass}">● ${legendLabels[s]}</span>`;
        }).join('');

        section.innerHTML = `
            ${warningHTML}
            <div class="fsi-composite-card">
                <div class="fsi-score-display">
                    <span class="fsi-score">${composite.score}</span>
                    <span class="fsi-status-badge" style="background: ${classification.color}20; color: ${classification.color}">
                        ${classification.status}
                    </span>
                    ${trendHTML}
                </div>
                <p class="fsi-explanation">Failed Student Interactions — measures student experience across digital touchpoints. Lower is better. Composite of Availability (50%), Incidents (20%), Sessions (15%), Performance (15%).</p>
                <div class="fsi-legend">
                    ${legendHTML}
                </div>
                ${chartHTML}
            </div>
        `;

        // Initialize ECharts if we have enough data
        if (trendData.length >= 2) {
            const chartEl = document.getElementById('fsi-trend-chart');
            if (chartEl) {
                const chart = echarts.init(chartEl);
                chart.setOption(buildFSITrendChart(trendData));
                registerChart(chart);
            }
        }
    } catch (err) {
        console.error('FSI Composite render failed:', err);
        section.innerHTML = renderSectionError('FSI', 'render_failed');
    }
}

/**
 * FSI Pillars section: 4 pillars with score, weight, contribution.
 * Highlights pillars whose score exceeds the composite by >10 points.
 */
function renderFSIPillars(context) {
    const section = document.getElementById('fsi-pillars-section');
    try {
        const { fsiData } = context;

        if (!fsiData.available) {
            section.innerHTML = renderSectionError('FSI Pillars', fsiData.reason);
            return;
        }

        const envelope = fsiData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const { composite, pillars } = envelope.data;
        const compositeScore = composite.score;

        // Normalize pillars: the collector returns objects {score, weight, ...}
        // but computePillarContributions expects plain numbers
        const normalizedPillars = {};
        for (const [key, val] of Object.entries(pillars)) {
            normalizedPillars[key] = (val && typeof val === 'object') ? val.score : val;
        }

        // Compute pillar contributions
        const pillarData = computePillarContributions(normalizedPillars);

        // Check if all pillars are null (no data)
        const allNull = pillarData.every(p => p.score === null);
        if (allNull) {
            section.innerHTML = `
                ${warningHTML}
                <div class="empty-state">
                    FSI pillar data is currently unavailable for: Availability, Incidents, Sessions, Performance
                </div>
            `;
            return;
        }

        // Build pillar cards — highlight if score > composite + 10
        // Show actual metric value as headline (99.75%, 0.91M sessions, etc.)
        // with FSI score as secondary context.
        // Sessions pillar uses FSI board pattern: count primary, Apdex secondary.
        const pillarCards = pillarData.map(p => {
            const highlighted = p.score != null && p.score > compositeScore + 10;
            const highlightClass = highlighted ? ' highlighted' : '';
            const scoreDisplay = p.score != null ? p.score : '—';
            const contributionDisplay = p.contribution != null ? p.contribution.toFixed(1) : '—';
            const weightPercent = Math.round(p.weight * 100);

            // Extract the actual metric value from the raw pillar object
            const rawPillar = pillars[p.name.toLowerCase()];
            const actualValue = formatPillarActualValue(p.name, rawPillar);

            // Secondary metric line — Sessions shows Apdex below the count
            let secondaryHTML = '';
            if (p.name.toLowerCase() === 'sessions' && rawPillar && rawPillar.session_count != null && rawPillar.apdex != null) {
                secondaryHTML = `<span class="pillar-secondary">Apdex: ${rawPillar.apdex}</span>`;
            }

            // Severity breakdown subtitle for incidents pillar
            let subtitleHTML = '';
            if (p.name.toLowerCase() === 'incidents' && rawPillar && rawPillar.total_count != null) {
                subtitleHTML = `<span class="pillar-subtitle">Sev1: ${rawPillar.sev1 || 0} | Sev2: ${rawPillar.sev2 || 0} | Sev3: ${rawPillar.sev3 || 0}</span>`;
            }

            return `
                <div class="pillar-card${highlightClass}">
                    <span class="pillar-name">${escapeHTML(p.name)}</span>
                    <span class="pillar-score">${actualValue}</span>
                    ${secondaryHTML}
                    ${subtitleHTML}
                    <span class="pillar-weight">${weightPercent}% weight · Score: ${scoreDisplay}</span>
                    <span class="pillar-contribution">Contribution: ${contributionDisplay}</span>
                </div>
            `;
        }).join('');

        section.innerHTML = `
            ${warningHTML}
            <div class="pillar-grid">
                ${pillarCards}
            </div>
        `;
    } catch (err) {
        console.error('FSI Pillars render failed:', err);
        section.innerHTML = renderSectionError('FSI Pillars', 'render_failed');
    }
}

/**
 * ETRC Scores section: group-centric 2×2 card grid.
 * One card per ETRC group (4 groups), sorted worst-grade-first.
 * Each card shows grade, group name, score, and the SEMs mapped to that group.
 * Click navigates to the team view for the first SEM in that group.
 */
function renderETRCScores(context) {
    const section = document.getElementById('etrc-scores-section');
    try {
        const { etrcData, teamConfig, isDisplay } = context;

        if (!etrcData.available) {
            section.innerHTML = renderSectionError('ETRC', etrcData.reason);
            return;
        }

        const envelope = etrcData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const groups = envelope.data.groups;

        // For each group, find which SEMs map to it via teamConfig
        const groupCards = groups.map(group => {
            const sems = [];
            for (const [semName, semConfig] of Object.entries(teamConfig.sems)) {
                if ((semConfig.etrcTeams || []).includes(group.group_sys_id)) {
                    sems.push(semName);
                }
            }
            return {
                groupName: group.group_name,
                groupSysId: group.group_sys_id,
                grade: group.grade || null,
                score: group.total_score,
                sems
            };
        });

        // Sort by grade worst-first: F=0, D=1, C=2, B=3, A=4
        // Within same grade, alphabetical by group name
        const gradeOrder = { F: 0, D: 1, C: 2, B: 3, A: 4 };
        groupCards.sort((a, b) => {
            const aOrder = a.grade != null ? (gradeOrder[a.grade] ?? 2) : -1;
            const bOrder = b.grade != null ? (gradeOrder[b.grade] ?? 2) : -1;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return a.groupName.localeCompare(b.groupName);
        });

        // Render cards
        const cardsHTML = groupCards.map(card => {
            const gradeColor = gradeToColor(card.grade);
            const gradeDisplay = card.grade || 'N/A';
            const scoreDisplay = card.score != null ? `${card.score.toFixed(1)} / 4.0` : '—';
            const semsDisplay = card.sems.join(', ') || 'None';

            // Click navigates to team view for the first SEM in this group
            const firstSEM = card.sems[0] || '';
            const clickable = !isDisplay && firstSEM ? ' data-clickable' : '';
            const clickHandler = !isDisplay && firstSEM
                ? ` onclick="window.location.href='operations.html?sem=${encodeURIComponent(firstSEM)}'"` : '';

            return `
                <div class="etrc-group-card"${clickable}${clickHandler}>
                    <div class="etrc-group-grade" ${gradeColor ? `style="color: ${gradeColor}"` : ''}>${gradeDisplay}</div>
                    <div class="etrc-group-info">
                        <span class="etrc-group-name">${escapeHTML(card.groupName)}</span>
                        <span class="etrc-group-score">${scoreDisplay}</span>
                        <span class="etrc-group-sems">${escapeHTML(semsDisplay)}</span>
                    </div>
                </div>
            `;
        }).join('');

        section.innerHTML = `
            ${warningHTML}
            <div class="etrc-group-grid">
                ${cardsHTML}
            </div>
        `;
    } catch (err) {
        console.error('ETRC Scores render failed:', err);
        section.innerHTML = renderSectionError('ETRC', 'render_failed');
    }
}

/**
 * AI Insights section: VP-level summary from the insights collector.
 * Renders vp_summary as formatted paragraphs with generation metadata.
 * Hidden entirely if insights data is unavailable.
 */
function renderInsights(context) {
    const section = document.getElementById('insights-section');
    if (!section) return;

    const { insightsData } = context;

    // Hide section entirely if data unavailable — no error state per spec
    if (!insightsData || !insightsData.available || !insightsData.data) {
        section.style.display = 'none';
        return;
    }

    try {
        const envelope = insightsData.data;
        const vpSummary = envelope.data && envelope.data.vp_summary;

        if (!vpSummary) {
            section.style.display = 'none';
            return;
        }

        // Extract metadata for the generation timestamp
        const metadata = envelope.data.metadata || {};
        const generatedAt = metadata.generated_at ? formatTimestamp(metadata.generated_at) : '';
        const model = metadata.model || '';

        // Convert double-newline-separated paragraphs to HTML
        // Bold the first sentence of each paragraph (BLUF highlighting)
        const paragraphs = vpSummary.split('\n\n')
            .filter(p => p.trim())
            .map(p => {
                const text = p.trim();
                // Split at first sentence boundary (period followed by space or end)
                const firstSentenceEnd = text.search(/\.\s/);
                if (firstSentenceEnd > 0) {
                    const first = text.slice(0, firstSentenceEnd + 1);
                    const rest = text.slice(firstSentenceEnd + 1);
                    return `<p><strong>${escapeHTML(first)}</strong>${escapeHTML(rest)}</p>`;
                }
                return `<p><strong>${escapeHTML(text)}</strong></p>`;
            })
            .join('');

        // Build meta line: timestamp and model name
        const metaParts = [];
        if (generatedAt) metaParts.push(`Generated ${generatedAt}`);
        if (model) metaParts.push(model);
        const metaHTML = metaParts.length > 0
            ? `<span class="insights-meta">${escapeHTML(metaParts.join(' · '))}</span>`
            : '';

        section.innerHTML = `
            <div class="insights-card">
                <h3 class="insights-heading">What's Driving the Numbers</h3>
                <div class="insights-body">${paragraphs}</div>
                ${metaHTML}
            </div>
        `;
    } catch (err) {
        console.error('Insights render failed:', err);
        section.style.display = 'none';
    }
}

/**
 * Weekly MIs section: severity buckets with counts, detail list, scrollable if >10.
 * Scoped to the preceding work week.
 */
function renderWeeklyMIs(context) {
    const section = document.getElementById('mi-weekly-section');
    try {
        const { incidentData } = context;

        if (!incidentData.available) {
            section.innerHTML = renderSectionError('Major Incidents', incidentData.reason);
            return;
        }

        const envelope = incidentData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        // Filter out Closed/Cancelled MIs — retracted, not real incidents
        const mis = (envelope.data.major_incidents || []).filter(mi => mi.state !== 'Closed/Cancelled');

        // If no MIs, show confirmation message
        if (mis.length === 0) {
            const weekStart = envelope.data.metadata.week_start || '';
            const weekEnd = envelope.data.metadata.week_end || '';
            section.innerHTML = `
                ${warningHTML}
                <div class="mi-section">
                    <div class="empty-state">No MIs recorded for the week of ${escapeHTML(weekStart)} – ${escapeHTML(weekEnd)}</div>
                </div>
            `;
            return;
        }

        // Bucket MIs by severity
        const { buckets, total } = bucketMIsBySeverity(mis);

        // Build severity bucket cards
        const sevLabels = { 1: 'Sev 1', 2: 'Sev 2', 3: 'Sev 3', 4: 'Sev 4' };
        const sevClasses = { 1: 'sev1', 2: 'sev2', 3: 'sev3', 4: 'sev4' };
        const bucketsHTML = [1, 2, 3, 4].map(sev => `
            <div class="mi-bucket ${sevClasses[sev]}">
                <span class="mi-bucket-label">${sevLabels[sev]}</span>
                <span class="mi-bucket-count">${buckets[sev].length}</span>
            </div>
        `).join('');

        // Build detail list — all MIs sorted by severity desc, then opened_at desc
        const allMIs = [...mis].sort((a, b) => {
            const sevA = parseInt((a.priority || '').replace(/\D/g, ''), 10) || 99;
            const sevB = parseInt((b.priority || '').replace(/\D/g, ''), 10) || 99;
            if (sevA !== sevB) return sevA - sevB;
            return new Date(b.opened_at) - new Date(a.opened_at);
        });

        const listHTML = allMIs.map(mi => {
            const desc = truncate(escapeHTML(mi.short_description), 120);
            const duration = formatDuration(mi.opened_at, mi.resolved_at);
            const group = escapeHTML(mi.assignment_group || '');
            const miUrl = buildMIUrl(mi.number);
            const numberHTML = miUrl
                ? `<a class="mi-number" href="${miUrl}" target="_blank" rel="noopener">${escapeHTML(mi.number)}</a>`
                : `<span class="mi-number">${escapeHTML(mi.number)}</span>`;

            return `
                <div class="mi-item">
                    ${numberHTML}
                    <span class="mi-description" title="${escapeHTML(mi.short_description)}">${desc}</span>
                    <span class="mi-state">${escapeHTML(mi.state || '')}</span>
                    <span class="mi-duration">${duration}</span>
                    <span class="mi-group">${group}</span>
                </div>
            `;
        }).join('');

        section.innerHTML = `
            ${warningHTML}
            <div class="mi-section">
                <div class="mi-total-header">Major Incidents: <span class="mi-count">${total}</span></div>
                <div class="mi-buckets">
                    ${bucketsHTML}
                </div>
                <div class="mi-list">
                    ${listHTML}
                </div>
            </div>
        `;
    } catch (err) {
        console.error('Weekly MIs render failed:', err);
        section.innerHTML = renderSectionError('Major Incidents', 'render_failed');
    }
}

/**
 * Incident Trends section: dual-axis chart (volume bars + MTTR line), 12-week trailing.
 * Scoped to Sev 1-3 only. Merges historical + current incidents.
 */
function renderIncidentTrends(context) {
    const section = document.getElementById('incident-trends-section');
    try {
        const { incidentData, historical } = context;

        if (!incidentData.available) {
            section.innerHTML = renderSectionError('Incident Trends', incidentData.reason);
            return;
        }

        const envelope = incidentData.data;
        const warningHTML = renderEnvelopeWarning(envelope);

        // Merge all regular incidents from historical envelopes + current
        let allIncidents = [];

        // Historical incidents (from prior week envelopes)
        for (const histEnvelope of (historical.incidents || [])) {
            if (histEnvelope && histEnvelope.data && histEnvelope.data.regular_incidents) {
                allIncidents = allIncidents.concat(histEnvelope.data.regular_incidents);
            }
        }

        // Current week's incidents
        if (envelope.data.regular_incidents) {
            allIncidents = allIncidents.concat(envelope.data.regular_incidents);
        }

        // Filter to Sev 1-3 only
        const filtered = filterBySeverity(allIncidents, 3);

        // Bucket into weeks
        const weeklyData = bucketIncidentsByWeek(filtered, 12);

        // Need at least 2 weeks with data for a trend chart
        const weeksWithData = weeklyData.filter(w => w.count > 0);
        if (weeksWithData.length < 2) {
            section.innerHTML = `
                ${warningHTML}
                <div class="empty-state">Insufficient data for trend visualization — at least 2 weeks of incident data required</div>
            `;
            return;
        }

        section.innerHTML = `
            ${warningHTML}
            <div class="chart-container" id="incident-trend-chart"></div>
        `;

        // Initialize ECharts
        const chartEl = document.getElementById('incident-trend-chart');
        if (chartEl) {
            const chart = echarts.init(chartEl);
            chart.setOption(buildIncidentTrendChart(weeklyData));
            registerChart(chart);
        }
    } catch (err) {
        console.error('Incident Trends render failed:', err);
        section.innerHTML = renderSectionError('Incident Trends', 'render_failed');
    }
}

/**
 * Global timestamp: oldest collected_at across all data sources.
 * Adds staleness indicator if >36h old.
 */
function renderGlobalTimestamp(context) {
    const el = document.getElementById('globalTimestamp');
    if (!el) return;

    try {
        const { fsiData, etrcData, incidentData } = context;

        // Collect all available collected_at timestamps
        const timestamps = [];
        if (fsiData.available && fsiData.data) {
            timestamps.push(fsiData.data.collected_at);
        }
        if (etrcData.available && etrcData.data) {
            timestamps.push(etrcData.data.collected_at);
        }
        if (incidentData.available && incidentData.data) {
            timestamps.push(incidentData.data.collected_at);
        }

        const oldest = findOldestTimestamp(timestamps);
        if (!oldest) {
            el.textContent = 'Last updated: Unknown';
            return;
        }

        const stale = isStale(oldest, 36);
        const formatted = formatTimestamp(oldest);
        const staleLabel = stale ? ' (stale)' : '';

        el.textContent = `Last updated: ${formatted}${staleLabel}`;
        if (stale) {
            el.classList.add('stale');
        }
    } catch (err) {
        console.error('Global timestamp render failed:', err);
        el.textContent = 'Last updated: Unknown';
    }
}
