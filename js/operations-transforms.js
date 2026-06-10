/**
 * operations-transforms.js — Pure data transformation functions.
 *
 * No DOM access, no side effects. These are the functions that property-based
 * tests target directly.
 */

/**
 * Derive FSI status label and color from numeric score.
 * Score 0-100, lower is better.
 *
 * Thresholds:
 *   0-10: Optimal (green)
 *   11-25: Stable (green)
 *   26-40: Elevated (amber)
 *   41-60: Severe (red)
 *   61-100: Systemic (red)
 */
export function classifyFSIScore(score) {
    if (score <= 10) return { status: 'Optimal', color: '#2d8a4e', severity: 'green' };
    if (score <= 25) return { status: 'Stable', color: '#5a9a3c', severity: 'green' };
    if (score <= 40) return { status: 'Elevated', color: '#c9922e', severity: 'amber' };
    if (score <= 60) return { status: 'Severe', color: '#c95e2e', severity: 'red' };
    return { status: 'Systemic', color: '#c92e2e', severity: 'red' };
}

/**
 * Parse a severity value from either MI format ("Sev 1") or regular incident format ("1").
 * Returns integer 1-4, or NaN if unparseable.
 */
export function parseSeverity(priority) {
    if (typeof priority === 'number') return priority;
    if (typeof priority !== 'string') return NaN;
    // MI format: "Sev 1", "Sev 2", etc.
    const sevMatch = priority.match(/^Sev\s+(\d+)$/i);
    if (sevMatch) return parseInt(sevMatch[1], 10);
    // Regular incident format: "1", "2", etc.
    const num = parseInt(priority, 10);
    return isNaN(num) ? NaN : num;
}

/**
 * Group MIs by severity bucket.
 * Returns { buckets: {1: [...], 2: [...], 3: [...], 4: [...]}, total }
 *
 * Each MI is placed into exactly one bucket based on its priority field.
 * MIs with priorities outside 1-4 are excluded from all buckets.
 */
export function bucketMIsBySeverity(mis) {
    const buckets = { 1: [], 2: [], 3: [], 4: [] };
    for (const mi of mis) {
        const sev = parseSeverity(mi.priority);
        if (sev >= 1 && sev <= 4) {
            buckets[sev].push(mi);
        }
    }
    const total = Object.values(buckets).reduce((sum, arr) => sum + arr.length, 0);
    return { buckets, total };
}

/**
 * Filter incidents to only those with priority <= maxSev.
 *
 * Regular incidents use numeric string priorities ("1" through "4").
 * Returns a new array containing only incidents whose parsed severity
 * is >= 1 and <= maxSev.
 */
export function filterBySeverity(incidents, maxSev = 3) {
    return incidents.filter(inc => {
        const sev = parseSeverity(inc.priority);
        return sev >= 1 && sev <= maxSev;
    });
}

/**
 * Map ETRC letter grade to hex color.
 * Returns the corresponding color for grades A-F, or null for any other input.
 */
export function gradeToColor(grade) {
    const map = { A: '#2d8a4e', B: '#5a9a3c', C: '#c9922e', D: '#c95e2e', F: '#c92e2e' };
    // hasOwn guards against Object.prototype properties like "toString", "valueOf"
    return Object.hasOwn(map, grade) ? map[grade] : null;
}

/**
 * Sort ETRC rows: F first, then D, then NoData (null), then C, B, A.
 * Within same grade, alphabetical by SEM name.
 *
 * Grade order: F=0, D=1, null=2, C=3, B=4, A=5
 * This places teams needing the most attention at the top.
 */
export function sortETRCRows(rows) {
    const order = { F: 0, D: 1, null: 2, C: 3, B: 4, A: 5 };
    return [...rows].sort((a, b) => {
        const aOrder = order[a.grade] ?? 2;
        const bOrder = order[b.grade] ?? 2;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.semName.localeCompare(b.semName);
    });
}

/**
 * Compute weighted contribution for each FSI pillar.
 * Weights: Availability 0.50, Incidents 0.20, Sessions 0.15, Performance 0.15
 * Returns array of { name, score, weight, contribution } objects.
 * contribution = score × weight rounded to 1 decimal place.
 * If a pillar score is null/undefined, contribution is null.
 */
export function computePillarContributions(pillars) {
    const weights = { Availability: 0.50, Incidents: 0.20, Sessions: 0.15, Performance: 0.15 };
    return Object.entries(weights).map(([name, weight]) => {
        // Handle both formats: plain number (mock data) or object with .score (real collector)
        const raw = pillars[name.toLowerCase()];
        const score = (raw != null && typeof raw === 'object') ? raw.score : raw;
        return {
            name,
            score: score ?? null,
            weight,
            contribution: score != null ? +(score * weight).toFixed(1) : null
        };
    });
}

/**
 * Compute week-over-week FSI trend.
 * Returns { diff, direction, label } where:
 *   diff = currentScore - priorScore
 *   direction: 'up' (worsening) if diff > 0, 'down' (improving) if diff < 0, 'flat' if diff === 0
 *   label: "+N" for positive, "N" (with minus sign) for negative, "0" for flat
 * Returns null if priorScore is null/undefined.
 */
export function computeFSITrend(currentScore, priorScore) {
    if (priorScore == null) return null;
    const diff = currentScore - priorScore;
    return {
        diff,
        direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        label: diff > 0 ? `+${diff}` : `${diff}`
    };
}

/**
 * Compute MTTR (median hours) from a set of incidents.
 * Only incidents with a non-null resolved_at are included.
 * Returns null if no resolved incidents exist.
 *
 * Median: for odd-length arrays, the middle element; for even-length,
 * the average of the two middle elements. Duration is measured in hours
 * from opened_at to resolved_at.
 */
export function computeMTTR(incidents) {
    // Filter to only resolved incidents
    const resolved = incidents.filter(i => i.resolved_at != null);
    if (resolved.length === 0) return null;

    // Compute duration in hours for each resolved incident
    const durations = resolved.map(i => {
        const opened = new Date(i.opened_at);
        const closed = new Date(i.resolved_at);
        return (closed - opened) / (1000 * 60 * 60);
    }).sort((a, b) => a - b);

    // Compute median
    const mid = Math.floor(durations.length / 2);
    const median = durations.length % 2 === 0
        ? (durations[mid - 1] + durations[mid]) / 2
        : durations[mid];

    return +median.toFixed(1);
}

/**
 * Determine the preceding work week boundaries (Mon 00:00 – Sun 23:59).
 *
 * "Preceding work week" = the most recent complete Mon-Sun week before
 * the reference date. If referenceDate is a Sunday, the preceding week
 * ended the Sunday before (not today).
 *
 * Returns { start: Date (Monday 00:00:00.000), end: Date (Sunday 23:59:59.999) }
 */
export function getPrecedingWorkWeek(referenceDate = new Date()) {
    const d = new Date(referenceDate);
    const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon, ...

    // Days since the most recent completed Sunday:
    // Mon(1)->1, Tue(2)->2, ... Sat(6)->6, Sun(0)->7
    const daysSinceSunday = dayOfWeek === 0 ? 7 : dayOfWeek;

    // End of the preceding week: last Sunday at 23:59:59.999
    const lastSunday = new Date(d);
    lastSunday.setDate(d.getDate() - daysSinceSunday);
    lastSunday.setHours(23, 59, 59, 999);

    // Start of the preceding week: the Monday before that Sunday
    const lastMonday = new Date(lastSunday);
    lastMonday.setDate(lastSunday.getDate() - 6);
    lastMonday.setHours(0, 0, 0, 0);

    return { start: lastMonday, end: lastSunday };
}

/**
 * Generate week boundaries for N weeks ending before the current date.
 * Each week runs Mon 00:00 through the following Mon 00:00 (exclusive end).
 * Returns array of { start, end, weekEnding } objects, oldest first.
 *
 * weekEnding is the ISO date string (YYYY-MM-DD) of the Sunday closing that week.
 */
function generateWeekBoundaries(numWeeks) {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...

    // Find the most recent completed Sunday
    const daysSinceSunday = dayOfWeek === 0 ? 7 : dayOfWeek;
    const lastSunday = new Date(now);
    lastSunday.setDate(now.getDate() - daysSinceSunday);
    lastSunday.setHours(23, 59, 59, 999);

    const weeks = [];
    for (let i = 0; i < numWeeks; i++) {
        // Week ending Sunday, going backwards
        const weekEnd = new Date(lastSunday);
        weekEnd.setDate(lastSunday.getDate() - (i * 7));

        // Week starting Monday (6 days before Sunday)
        const weekStart = new Date(weekEnd);
        weekStart.setDate(weekEnd.getDate() - 6);
        weekStart.setHours(0, 0, 0, 0);

        // Exclusive end for filtering: Monday 00:00 after the Sunday
        const exclusiveEnd = new Date(weekEnd);
        exclusiveEnd.setDate(weekEnd.getDate() + 1);
        exclusiveEnd.setHours(0, 0, 0, 0);

        // weekEnding as YYYY-MM-DD of the Sunday
        const weekEnding = weekEnd.toISOString().split('T')[0];

        weeks.push({ start: weekStart, end: exclusiveEnd, weekEnding });
    }

    // Return oldest first
    return weeks.reverse();
}

/**
 * Bucket incidents into weeks (Mon-Sun).
 * Returns array of { weekEnding, count, mttr } objects, oldest first.
 *
 * Each incident is placed into the week where its opened_at falls.
 * MTTR is computed per-week from only that week's resolved incidents.
 */
export function bucketIncidentsByWeek(incidents, numWeeks = 12) {
    const weeks = generateWeekBoundaries(numWeeks);
    return weeks.map(({ start, end, weekEnding }) => {
        // Filter incidents whose opened_at falls within [start, end)
        const weekIncidents = incidents.filter(i => {
            const opened = new Date(i.opened_at);
            return opened >= start && opened < end;
        });
        return {
            weekEnding,
            count: weekIncidents.length,
            mttr: computeMTTR(weekIncidents)
        };
    });
}

/**
 * Detect staleness: returns true if collectedAt is older than thresholdHours
 * from the current time.
 *
 * collectedAt: ISO 8601 timestamp string
 * thresholdHours: number of hours (default 36)
 */
export function isStale(collectedAt, thresholdHours = 36) {
    const collected = new Date(collectedAt);
    const now = new Date();
    const ageHours = (now - collected) / (1000 * 60 * 60);
    return ageHours > thresholdHours;
}

/**
 * Find the oldest timestamp from an array of ISO timestamp strings.
 * Ignores null/undefined entries.
 * Returns the oldest as an ISO string, or null if no valid timestamps exist.
 */
export function findOldestTimestamp(timestamps) {
    const valid = timestamps.filter(t => t != null).map(t => new Date(t));
    if (valid.length === 0) return null;
    return new Date(Math.min(...valid)).toISOString();
}

/**
 * Resolve SEM prev/next navigation with wrapping.
 *
 * Given a SEM name and the ordered list of all SEM names, returns
 * { prev, next } where prev/next wrap around the ends of the list.
 * Returns null if semName is not found in semNames.
 */
export function getAdjacentSEMs(semName, semNames) {
    const idx = semNames.indexOf(semName);
    if (idx === -1) return null;
    const prev = semNames[(idx - 1 + semNames.length) % semNames.length];
    const next = semNames[(idx + 1) % semNames.length];
    return { prev, next };
}

/**
 * Generate historical file paths for a collector.
 * Returns array of paths for the prior N weeks, each 7 days apart
 * counting backwards from today.
 *
 * Pattern: data/{collectorName}/{collectorName}_{YYYY-MM-DD}.json
 */
export function deriveHistoricalPaths(collectorName, numWeeks = 12) {
    const paths = [];
    const now = new Date();
    for (let i = 1; i <= numWeeks; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - (i * 7));
        const dateStr = d.toISOString().split('T')[0];
        paths.push(`data/${collectorName}/${collectorName}_${dateStr}.json`);
    }
    return paths;
}

/**
 * Build a ServiceNow URL for a Major Incident by its number.
 * Opens the u_major_incident record directly in the ServiceNow UI.
 *
 * Instance is hardcoded to wgu.service-now.com — if this changes,
 * update here (single source of truth for the frontend).
 */
export function buildMIUrl(miNumber) {
    if (!miNumber) return null;
    return `https://wgu.service-now.com/u_major_incident.do?sysparm_query=number=${encodeURIComponent(miNumber)}`;
}
