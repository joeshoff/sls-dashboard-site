/**
 * team-operations.js — Team-level operations view section renderers.
 *
 * Renders a single SEM's operational posture: ETRC grade breakdown with
 * component detail, team incidents filtered by org ID, MTTR current + trend,
 * and Major Incident exposure scoped to the SEM's ETRC groups.
 *
 * Each section renders independently inside a try/catch — a failure
 * in one section doesn't cascade to the others.
 *
 * Exported entry point: renderTeamView(container, semName, context)
 * Called by operations-router.js via dynamic import.
 */

import {
    getAdjacentSEMs,
    gradeToColor,
    filterBySeverity,
    computeMTTR,
    bucketMIsBySeverity,
    bucketIncidentsByWeek,
    isStale,
    findOldestTimestamp,
    parseSeverity,
    buildMIUrl
} from './operations-transforms.js';

import {
    buildETRCTrendChart,
    buildIncidentTrendChart
} from './operations-charts.js';

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
 * Format a duration between two ISO timestamps as human-readable age.
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
 * Compute age from opened_at to now as "Xd Yh" string.
 */
function formatAge(openedAt) {
    const ms = Date.now() - new Date(openedAt).getTime();
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
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

/**
 * Resolve ETRC group names for a SEM from the team config and ETRC data.
 * Returns array of group name strings.
 */
function getETRCGroupNames(semName, teamConfig, etrcData) {
    const semConfig = teamConfig.sems[semName];
    if (!semConfig || !semConfig.etrcTeams) return [];

    // If ETRC data is available, look up group names by sys_id
    if (etrcData && etrcData.available && etrcData.data && etrcData.data.data && etrcData.data.data.groups) {
        const groupLookup = {};
        for (const group of etrcData.data.data.groups) {
            groupLookup[group.group_sys_id] = group.group_name;
        }
        return semConfig.etrcTeams.map(id => groupLookup[id] || id);
    }

    // Fallback: return sys_ids if no ETRC data
    return semConfig.etrcTeams;
}

/**
 * Find other SEMs who share a given ETRC group sys_id.
 * Returns array of SEM names (excluding the current SEM).
 */
function findSharedGroupSEMs(groupSysId, currentSEM, teamConfig) {
    const shared = [];
    for (const [semName, semConfig] of Object.entries(teamConfig.sems)) {
        if (semName === currentSEM) continue;
        if (semConfig.etrcTeams && semConfig.etrcTeams.includes(groupSysId)) {
            shared.push(semName);
        }
    }
    return shared;
}

// ─── ECharts Instance Tracking ───────────────────────────────────────────────

// Track all chart instances for debounced resize
const chartInstances = [];
let resizeTimer = null;
let resizeListenerAttached = false;

/**
 * Register a chart instance for resize handling.
 * Sets up a single debounced resize listener on first call.
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
function clearChartRegistry() {
    chartInstances.length = 0;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Render the team-level operations view for a single SEM.
 *
 * Sets up the page skeleton with header (SEM name, group names, prev/next nav),
 * then calls each section renderer independently inside try/catch.
 *
 * @param {HTMLElement} container - The #app container element
 * @param {string} semName - The SEM name from the URL parameter
 * @param {Object} context - { teamConfig, fsiData, etrcData, incidentData, historical, isDisplay }
 */
export function renderTeamView(container, semName, context) {
    // Clear chart registry before re-rendering (prevents stale references on refresh)
    clearChartRegistry();

    const { teamConfig, etrcData, isDisplay } = context;
    const semNames = Object.keys(teamConfig.sems);
    const adjacent = getAdjacentSEMs(semName, semNames);

    // Resolve ETRC group names for display in the header
    const groupNames = getETRCGroupNames(semName, teamConfig, etrcData);

    // Build navigation HTML — hidden in display mode via CSS
    const navHTML = adjacent ? `
        <div class="sem-nav">
            <a href="?sem=${encodeURIComponent(adjacent.prev)}${isDisplay ? '&display=true' : ''}" class="sem-nav-btn" aria-label="Previous SEM: ${escapeHTML(adjacent.prev)}">← ${escapeHTML(adjacent.prev)}</a>
            <h1>${escapeHTML(semName)}</h1>
            <a href="?sem=${encodeURIComponent(adjacent.next)}${isDisplay ? '&display=true' : ''}" class="sem-nav-btn" aria-label="Next SEM: ${escapeHTML(adjacent.next)}">${escapeHTML(adjacent.next)} →</a>
        </div>
    ` : `<h1>${escapeHTML(semName)}</h1>`;

    container.innerHTML = `
        <div class="ops-header">
            <div class="team-nav">
                <a href="operations.html${isDisplay ? '?display=true' : ''}" class="back-link">← All Teams</a>
                ${navHTML}
            </div>
            <div class="sem-groups">${groupNames.map(n => escapeHTML(n)).join(', ')}</div>
            <div class="last-updated" id="teamTimestamp"></div>
        </div>
        <div id="team-etrc-section" class="ops-section"></div>
        <div id="team-incidents-section" class="ops-section"></div>
        <div id="team-mttr-section" class="ops-section"></div>
        <div id="team-mi-section" class="ops-section"></div>
    `;

    // Render each section independently — errors are contained
    renderTeamETRC(semName, context);
    renderGroupInsight(semName, context);
    renderTeamIncidents(semName, context);
    renderTeamMTTR(semName, context);
    renderTeamMIExposure(semName, context);
    renderTeamTimestamp(context);
}

// ─── Section Renderers ───────────────────────────────────────────────────────

/**
 * ETRC section: overall grade (2× font), component breakdown, 12-week trend.
 * For multi-group SEMs (e.g., Temi: Pre + Post), renders each group separately.
 */
function renderTeamETRC(semName, context) {
    const section = document.getElementById('team-etrc-section');
    try {
        const { etrcData, teamConfig, historical } = context;

        if (!etrcData.available) {
            section.innerHTML = renderSectionError('ETRC', etrcData.reason);
            return;
        }

        const envelope = etrcData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const groups = envelope.data.groups;
        const semConfig = teamConfig.sems[semName];

        // Build lookup: group_sys_id → group data
        const groupLookup = {};
        for (const group of groups) {
            groupLookup[group.group_sys_id] = group;
        }

        // Render each ETRC group the SEM maps to
        const groupSections = semConfig.etrcTeams.map(groupId => {
            const groupData = groupLookup[groupId];
            if (!groupData) {
                return `<div class="empty-state">No ETRC data available for group ${escapeHTML(groupId)}</div>`;
            }

            // Overall grade at 2× font size with grade color
            const color = gradeToColor(groupData.grade) || 'var(--text)';
            const gradeHTML = `<span class="team-etrc-grade" style="color: ${color}">${escapeHTML(groupData.grade)}</span>`;

            // Component breakdown: name, value, weight, pass/fail
            const componentsHTML = groupData.components.map(comp => {
                const failClass = comp.passing ? '' : ' failing';
                const weightPct = Math.round(comp.weight * 100);
                return `
                    <div class="component-row${failClass}">
                        <span class="component-name">${escapeHTML(comp.name)}</span>
                        <span class="component-value">${comp.value.toFixed(1)}</span>
                        <span class="component-weight">${weightPct}%</span>
                    </div>
                `;
            }).join('');

            // Section heading for multi-group SEMs
            const heading = semConfig.etrcTeams.length > 1
                ? `<h3>${escapeHTML(groupData.group_name)}</h3>`
                : '';

            return `
                ${heading}
                ${gradeHTML}
                <div class="component-grid">${componentsHTML}</div>
            `;
        }).join('');

        // Build 12-week ETRC grade trend data from historical envelopes
        const trendData = buildETRCTrendData(semConfig.etrcTeams[0], historical.etrc, envelope);

        // Determine chart HTML — need at least 2 points for a line
        let chartHTML = '';
        if (trendData.length >= 2) {
            chartHTML = `<div class="chart-container" id="etrc-trend-chart"></div>`;
        } else if (trendData.length === 1) {
            chartHTML = `<div class="empty-state">Trend data requires at least 2 weekly collections</div>`;
        }

        section.innerHTML = `
            ${warningHTML}
            ${groupSections}
            ${chartHTML}
        `;

        // Initialize ECharts for the trend chart
        if (trendData.length >= 2) {
            const chartEl = document.getElementById('etrc-trend-chart');
            if (chartEl) {
                const chart = echarts.init(chartEl);
                chart.setOption(buildETRCTrendChart(trendData));
                registerChart(chart);
            }
        }
    } catch (err) {
        console.error('Team ETRC render failed:', err);
        section.innerHTML = renderSectionError('ETRC', 'render_failed');
    }
}

/**
 * Build ETRC grade trend data from historical envelopes + current.
 * Extracts the grade for a specific group_sys_id from each envelope.
 */
function buildETRCTrendData(groupSysId, historicalETRC, currentEnvelope) {
    const points = [];

    // Historical envelopes (oldest first)
    for (const envelope of (historicalETRC || [])) {
        if (!envelope || !envelope.data || !envelope.data.groups) continue;
        const group = envelope.data.groups.find(g => g.group_sys_id === groupSysId);
        if (group && group.grade) {
            const weekEnding = envelope.collected_at ? envelope.collected_at.split('T')[0] : '';
            points.push({ weekEnding, grade: group.grade });
        }
    }

    // Current envelope
    if (currentEnvelope && currentEnvelope.data && currentEnvelope.data.groups) {
        const group = currentEnvelope.data.groups.find(g => g.group_sys_id === groupSysId);
        if (group && group.grade) {
            const weekEnding = currentEnvelope.collected_at ? currentEnvelope.collected_at.split('T')[0] : '';
            points.push({ weekEnding, grade: group.grade });
        }
    }

    return points;
}

/**
 * Group Insight section: AI-generated insight for this SEM's ETRC group.
 * Appended as an .insights-card after the ETRC section content.
 * Hidden gracefully if insights data is unavailable.
 */
function renderGroupInsight(semName, context) {
    const etrcSection = document.getElementById('team-etrc-section');
    if (!etrcSection) return;

    const { insightsData, teamConfig } = context;

    // No insights data — hide gracefully (no error state)
    if (!insightsData || !insightsData.available || !insightsData.data) return;

    try {
        const envelope = insightsData.data;
        const groupInsights = envelope.data && envelope.data.group_insights;
        if (!groupInsights) return;

        const semConfig = teamConfig.sems[semName];
        if (!semConfig || !semConfig.etrcTeams || semConfig.etrcTeams.length === 0) return;

        // Render insight for each of this SEM's ETRC groups that has one
        for (const groupId of semConfig.etrcTeams) {
            const insight = groupInsights[groupId];
            if (!insight) continue;

            const insightDiv = document.createElement('div');
            insightDiv.className = 'insights-card';
            insightDiv.style.marginTop = '1rem';
            insightDiv.innerHTML = `
                <h3 class="insights-heading">What's Driving the Numbers</h3>
                <div class="insights-body"><p>${escapeHTML(insight)}</p></div>
            `;
            etrcSection.appendChild(insightDiv);
        }
    } catch (err) {
        console.error('Group insight render failed:', err);
    }
}

/**
 * Incidents section: filtered by SEM's orgIds, sorted by severity then opened_at,
 * truncated at 50 with total count, weekly volume chart for 12 weeks.
 */
function renderTeamIncidents(semName, context) {
    const section = document.getElementById('team-incidents-section');
    try {
        const { incidentData, teamConfig, historical } = context;

        if (!incidentData.available) {
            section.innerHTML = renderSectionError('Incidents', incidentData.reason);
            return;
        }

        const envelope = incidentData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const semConfig = teamConfig.sems[semName];
        const orgIds = semConfig.orgIds || [];

        // Merge all regular incidents from historical + current for the chart
        let allIncidents = [];
        for (const histEnvelope of (historical.incidents || [])) {
            if (histEnvelope && histEnvelope.data && histEnvelope.data.regular_incidents) {
                allIncidents = allIncidents.concat(histEnvelope.data.regular_incidents);
            }
        }
        if (envelope.data.regular_incidents) {
            allIncidents = allIncidents.concat(envelope.data.regular_incidents);
        }

        // Filter to this SEM's org IDs and Sev 1-3
        const semIncidents = filterBySeverity(
            allIncidents.filter(i => orgIds.includes(i.org_id)),
            3
        );

        // Current-period incidents for the list (from the current envelope only)
        const currentIncidents = filterBySeverity(
            (envelope.data.regular_incidents || []).filter(i => orgIds.includes(i.org_id)),
            3
        );

        // Sort: severity (highest/lowest number first), then opened_at (most recent first)
        const sorted = [...currentIncidents].sort((a, b) => {
            const sevA = parseSeverity(a.priority);
            const sevB = parseSeverity(b.priority);
            if (sevA !== sevB) return sevA - sevB;
            return new Date(b.opened_at) - new Date(a.opened_at);
        });

        // Truncate at 50 with total count
        const totalCount = sorted.length;
        const displayed = sorted.slice(0, 50);

        // Build incident list HTML
        let listHTML = '';
        if (displayed.length === 0) {
            listHTML = `<div class="empty-state">No incidents for this team in the current collection period</div>`;
        } else {
            const truncateNote = totalCount > 50
                ? `<div class="empty-state">Showing 50 of ${totalCount} incidents</div>`
                : '';

            const itemsHTML = displayed.map(inc => {
                const desc = truncate(escapeHTML(inc.short_description), 120);
                const fullDesc = escapeHTML(inc.short_description || '');
                const age = formatAge(inc.opened_at);
                const sev = parseSeverity(inc.priority);

                return `
                    <div class="incident-item">
                        <span class="incident-number">${escapeHTML(inc.number)}</span>
                        <span class="incident-description" title="${fullDesc}">${desc}</span>
                        <span class="incident-severity">Sev ${sev}</span>
                        <span class="incident-state">${escapeHTML(inc.state || '')}</span>
                        <span class="incident-age">${age}</span>
                    </div>
                `;
            }).join('');

            listHTML = `
                <div class="incident-list">${itemsHTML}</div>
                ${truncateNote}
            `;
        }

        // Bucket SEM-scoped incidents into weeks for the chart
        const weeklyData = bucketIncidentsByWeek(semIncidents, 12);

        // Need at least 2 weeks with data for a trend chart
        let chartHTML = '';
        const weeksWithData = weeklyData.filter(w => w.count > 0);
        if (weeksWithData.length >= 2) {
            chartHTML = `<div class="chart-container" id="team-incident-chart"></div>`;
        } else if (weeksWithData.length < 2 && semIncidents.length > 0) {
            chartHTML = `<div class="empty-state">Insufficient data for trend visualization — at least 2 weeks required</div>`;
        }

        section.innerHTML = `
            ${warningHTML}
            ${listHTML}
            ${chartHTML}
        `;

        // Initialize ECharts for the incident trend chart
        if (weeksWithData.length >= 2) {
            const chartEl = document.getElementById('team-incident-chart');
            if (chartEl) {
                const chart = echarts.init(chartEl);
                chart.setOption(buildIncidentTrendChart(weeklyData));
                registerChart(chart);
            }
        }
    } catch (err) {
        console.error('Team Incidents render failed:', err);
        section.innerHTML = renderSectionError('Incidents', 'render_failed');
    }
}

/**
 * MTTR section: current-period median MTTR value + 12-week trend line.
 * Scoped to this SEM's orgIds, Sev 1-3 only.
 */
function renderTeamMTTR(semName, context) {
    const section = document.getElementById('team-mttr-section');
    try {
        const { incidentData, teamConfig, historical } = context;

        if (!incidentData.available) {
            section.innerHTML = renderSectionError('MTTR', incidentData.reason);
            return;
        }

        const envelope = incidentData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const semConfig = teamConfig.sems[semName];
        const orgIds = semConfig.orgIds || [];

        // Merge all incidents from historical + current for the trend
        let allIncidents = [];
        for (const histEnvelope of (historical.incidents || [])) {
            if (histEnvelope && histEnvelope.data && histEnvelope.data.regular_incidents) {
                allIncidents = allIncidents.concat(histEnvelope.data.regular_incidents);
            }
        }
        if (envelope.data.regular_incidents) {
            allIncidents = allIncidents.concat(envelope.data.regular_incidents);
        }

        // Filter to this SEM's org IDs and Sev 1-3
        const semIncidents = filterBySeverity(
            allIncidents.filter(i => orgIds.includes(i.org_id)),
            3
        );

        // Current-period MTTR: from the most recent week's resolved incidents
        const currentWeekIncidents = filterBySeverity(
            (envelope.data.regular_incidents || []).filter(i => orgIds.includes(i.org_id)),
            3
        );
        const currentMTTR = computeMTTR(currentWeekIncidents);

        // MTTR display
        const mttrDisplay = currentMTTR != null
            ? `<span class="mttr-value">${currentMTTR}<span class="mttr-unit"> hours</span></span>`
            : `<span class="mttr-value">—<span class="mttr-unit"> no resolved incidents this period</span></span>`;

        // Bucket into weeks for the trend line
        const weeklyData = bucketIncidentsByWeek(semIncidents, 12);

        // Build MTTR-only trend data (filter out weeks with null MTTR)
        const mttrPoints = weeklyData.filter(w => w.mttr != null);

        let chartHTML = '';
        if (mttrPoints.length >= 2) {
            chartHTML = `<div class="chart-container" id="team-mttr-chart"></div>`;
        } else if (mttrPoints.length < 2) {
            chartHTML = `<div class="empty-state">Insufficient resolved incidents for MTTR trend (need at least 2 weeks with resolutions)</div>`;
        }

        section.innerHTML = `
            ${warningHTML}
            ${mttrDisplay}
            ${chartHTML}
        `;

        // Initialize ECharts for the MTTR trend line
        if (mttrPoints.length >= 2) {
            const chartEl = document.getElementById('team-mttr-chart');
            if (chartEl) {
                const chart = echarts.init(chartEl);
                // Use the incident trend chart (dual-axis) — it already handles MTTR line
                chart.setOption(buildIncidentTrendChart(weeklyData));
                registerChart(chart);
            }
        }
    } catch (err) {
        console.error('Team MTTR render failed:', err);
        section.innerHTML = renderSectionError('MTTR', 'render_failed');
    }
}

/**
 * MI Exposure section: MIs filtered by SEM's etrcTeams group_sys_ids,
 * severity buckets, shared-group indicator, 4-week trend summary.
 */
function renderTeamMIExposure(semName, context) {
    const section = document.getElementById('team-mi-section');
    try {
        const { incidentData, teamConfig, historical } = context;

        if (!incidentData.available) {
            section.innerHTML = renderSectionError('Major Incidents', incidentData.reason);
            return;
        }

        const envelope = incidentData.data;
        const warningHTML = renderEnvelopeWarning(envelope);
        const semConfig = teamConfig.sems[semName];
        const etrcTeams = semConfig.etrcTeams || [];

        // Filter MIs to this SEM's ETRC group sys_ids, excluding retracted (Closed/Cancelled)
        const allMIs = (envelope.data.major_incidents || []).filter(mi => mi.state !== 'Closed/Cancelled');
        const semMIs = allMIs.filter(mi => etrcTeams.includes(mi.group_sys_id));

        // Shared-group indicator: find other SEMs who share each group
        const sharedInfo = etrcTeams.map(groupId => {
            const otherSEMs = findSharedGroupSEMs(groupId, semName, teamConfig);
            return { groupId, otherSEMs };
        }).filter(info => info.otherSEMs.length > 0);

        // Build shared-group indicator HTML
        let sharedHTML = '';
        if (sharedInfo.length > 0) {
            const sharedLabels = sharedInfo.map(info => {
                const names = info.otherSEMs.map(n => escapeHTML(n)).join(', ');
                return `Shared with: ${names}`;
            });
            sharedHTML = `<div class="mi-exposure-header">${sharedLabels.join(' | ')}</div>`;
        }

        // No MIs — show confirmation message
        if (semMIs.length === 0) {
            section.innerHTML = `
                ${warningHTML}
                <div class="mi-exposure">
                    ${sharedHTML}
                    <div class="empty-state">No Major Incidents for this team's ETRC group(s) in the preceding work week</div>
                </div>
            `;
            // Still render 4-week trend summary below
            renderMITrendSummary(section, semName, context);
            return;
        }

        // Bucket by severity
        const { buckets, total } = bucketMIsBySeverity(semMIs);

        // Severity bucket cards
        const sevLabels = { 1: 'Sev 1', 2: 'Sev 2', 3: 'Sev 3', 4: 'Sev 4' };
        const sevClasses = { 1: 'sev1', 2: 'sev2', 3: 'sev3', 4: 'sev4' };
        const bucketsHTML = [1, 2, 3, 4].map(sev => `
            <div class="mi-bucket ${sevClasses[sev]}">
                <span class="mi-bucket-label">${sevLabels[sev]}</span>
                <span class="mi-bucket-count">${buckets[sev].length}</span>
            </div>
        `).join('');

        // MI detail list — sorted by severity desc, then opened_at desc
        const sortedMIs = [...semMIs].sort((a, b) => {
            const sevA = parseSeverity(a.priority);
            const sevB = parseSeverity(b.priority);
            if (sevA !== sevB) return sevA - sevB;
            return new Date(b.opened_at) - new Date(a.opened_at);
        });

        const listHTML = sortedMIs.map(mi => {
            const desc = truncate(escapeHTML(mi.short_description), 120);
            const fullDesc = escapeHTML(mi.short_description || '');
            const duration = formatDuration(mi.opened_at, mi.resolved_at);
            const miUrl = buildMIUrl(mi.number);
            const numberHTML = miUrl
                ? `<a class="mi-number" href="${miUrl}" target="_blank" rel="noopener">${escapeHTML(mi.number)}</a>`
                : `<span class="mi-number">${escapeHTML(mi.number)}</span>`;

            return `
                <div class="mi-item">
                    ${numberHTML}
                    <span class="mi-description" title="${fullDesc}">${desc}</span>
                    <span class="mi-state">${escapeHTML(mi.state || '')}</span>
                    <span class="mi-duration">${duration}</span>
                </div>
            `;
        }).join('');

        section.innerHTML = `
            ${warningHTML}
            <div class="mi-exposure">
                ${sharedHTML}
                <div class="mi-buckets">${bucketsHTML}</div>
                <div class="mi-list">${listHTML}</div>
            </div>
        `;

        // Append 4-week trend summary
        renderMITrendSummary(section, semName, context);
    } catch (err) {
        console.error('Team MI Exposure render failed:', err);
        section.innerHTML = renderSectionError('Major Incidents', 'render_failed');
    }
}

/**
 * Render the 4-week MI trend summary (count per week) below the MI exposure section.
 * Uses historical incident envelopes to count MIs per week for this SEM's ETRC groups.
 */
function renderMITrendSummary(section, semName, context) {
    const { historical, teamConfig, incidentData } = context;
    const semConfig = teamConfig.sems[semName];
    const etrcTeams = semConfig.etrcTeams || [];

    // Collect MI counts from historical envelopes (up to 3 prior weeks) + current
    const weekCounts = [];

    // Historical weeks (oldest first in the array)
    const histEnvelopes = (historical.incidents || []).slice(-3);
    for (const envelope of histEnvelopes) {
        if (!envelope || !envelope.data || !envelope.data.major_incidents) continue;
        const mis = envelope.data.major_incidents.filter(mi => mi.state !== 'Closed/Cancelled' && etrcTeams.includes(mi.group_sys_id));
        const weekLabel = envelope.collected_at ? envelope.collected_at.split('T')[0] : '?';
        weekCounts.push({ week: weekLabel, count: mis.length });
    }

    // Current week
    if (incidentData.available && incidentData.data && incidentData.data.data && incidentData.data.data.major_incidents) {
        const currentMIs = incidentData.data.data.major_incidents.filter(mi => mi.state !== 'Closed/Cancelled' && etrcTeams.includes(mi.group_sys_id));
        const weekLabel = incidentData.data.collected_at ? incidentData.data.collected_at.split('T')[0] : 'Current';
        weekCounts.push({ week: weekLabel, count: currentMIs.length });
    }

    if (weekCounts.length === 0) return;

    // Render the trend summary as week-count badges
    const trendHTML = weekCounts.map(wc =>
        `<span class="mi-week-count">${escapeHTML(wc.week)}: ${wc.count} MI${wc.count !== 1 ? 's' : ''}</span>`
    ).join('');

    // Append to the existing section content
    const trendDiv = document.createElement('div');
    trendDiv.className = 'mi-trend-summary';
    trendDiv.innerHTML = trendHTML;
    section.appendChild(trendDiv);
}

/**
 * Timestamp section: team-specific staleness indicator.
 * Shows the oldest collected_at across all data sources rendered on this view.
 * Adds staleness warning if >36h old.
 */
function renderTeamTimestamp(context) {
    const el = document.getElementById('teamTimestamp');
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
        console.error('Team timestamp render failed:', err);
        el.textContent = 'Last updated: Unknown';
    }
}
