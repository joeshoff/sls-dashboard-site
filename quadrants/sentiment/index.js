/**
 * Student Sentiment Quadrant Module
 *
 * Core computation and rendering for the sentiment card:
 * - Net sentiment score computation from post data
 * - Score formatting and attention-level classification
 * - Weekly trend aggregation by ISO week
 * - Category breakdown with sort and truncation
 * - Staleness detection and manifest-based data fetching
 * - Card rendering: score hero, SVG trend chart, category stacked bars
 */

// --- Module state ---
let _container = null;
let _rootEl = null;
let _lastGoodData = null;
let _abortController = null;

export const detailUrl = null;

// --- Quadrant Contract functions ---

/**
 * Initialize the sentiment card into the provided container.
 *
 * Renders the root element with quadrant-card class and data-attention-level,
 * fetches Reddit data via manifest, computes all derived values, and renders
 * the full card. Handles re-initialization by clearing previous container.
 * Sets attention to yellow as default before first successful load.
 *
 * @param {HTMLElement} containerElement - DOM element to render into
 * @returns {Promise<void>} Resolves once root and all content nodes are in DOM
 */
export async function init(containerElement) {
    // Re-initialization: clear previous container if switching to a new one
    if (_container && _container !== containerElement) {
        _container.innerHTML = '';
    }
    _container = containerElement;
    _container.innerHTML = '';

    // Load module-specific CSS (idempotent)
    _loadCSS();

    // Build root element with default yellow attention before first data load
    _rootEl = document.createElement('div');
    _rootEl.className = 'quadrant-card';
    _rootEl.setAttribute('data-attention-level', 'yellow');
    _container.appendChild(_rootEl);

    // Attempt initial data load and render
    try {
        const envelope = await _fetchRedditData();
        const state = _buildState(envelope);
        _applyState(state);
    } catch (err) {
        // Initial load failed — show error indicator, keep yellow attention
        _renderErrorState('Data unavailable');
    }
}

/**
 * Re-fetch Reddit data via manifest, recompute all values, and re-render.
 *
 * Uses AbortController with 10s timeout. On failure: shows error indicator,
 * retains last good render if one exists, and rejects with a descriptive Error.
 * On success: updates attention level based on freshly computed score.
 *
 * @returns {Promise<void>} Resolves on success, rejects on failure
 */
export async function refresh() {
    if (!_container || !_rootEl) return;

    try {
        const envelope = await _fetchRedditData();
        const state = _buildState(envelope);
        _applyState(state);
    } catch (err) {
        // On failure: show error indicator, retain last good state, reject
        _showRefreshError();
        throw new Error(`Refresh failed: ${err.message}`);
    }
}

/**
 * Remove all DOM content, cancel pending fetches, clear module state.
 *
 * @returns {Promise<void>} Resolves when cleanup is complete
 */
export async function destroy() {
    // Abort any pending fetch operations
    if (_abortController) {
        _abortController.abort();
        _abortController = null;
    }

    // Remove any portalled popups from body
    document.querySelectorAll('.sentiment-more-popup-portal').forEach(el => el.remove());

    // Clear DOM
    if (_container) {
        _container.innerHTML = '';
    }

    // Reset all module state
    _container = null;
    _rootEl = null;
    _lastGoodData = null;
}

// --- Internal helpers for contract functions ---

/**
 * Inject the sentiment quadrant CSS stylesheet into document head.
 * Idempotent — won't add a duplicate link element.
 */
function _loadCSS() {
    const cssId = 'sentiment-quadrant-css';
    if (document.getElementById(cssId)) return;

    const link = document.createElement('link');
    link.id = cssId;
    link.rel = 'stylesheet';
    link.href = 'quadrants/sentiment/sentiment.css';
    document.head.appendChild(link);
}

/**
 * Build the full computed SentimentState from a fetched reddit envelope.
 *
 * Handles zero-posts (returns null score, triggers "No data" rendering),
 * staleness detection, and all derived values (trend, breakdown, attention).
 *
 * @param {object} envelope - Parsed Reddit JSON envelope with data.posts and data.metadata
 * @returns {object} SentimentState object ready for rendering
 */
function _buildState(envelope) {
    const posts = envelope.data.posts;
    const metadata = envelope.data.metadata || {};
    const collectedAt = metadata.collected_at || envelope.collected_at;
    const isStale = _checkStaleness(collectedAt);

    // Zero posts: "No data" state with yellow attention
    if (!posts || posts.length === 0) {
        return {
            score: null,
            positivePercent: 0,
            negativePercent: 0,
            neutralPercent: 0,
            attentionLevel: 'yellow',
            weeklyTrend: [],
            categoryBreakdown: [],
            isStale,
            collectedAt,
            noData: true
        };
    }

    // Compute all derived values from post data
    const sentiment = _computeNetSentiment(posts);

    // If all posts have invalid sentiments, treat as no-data
    if (!sentiment) {
        return {
            score: null,
            positivePercent: 0,
            negativePercent: 0,
            neutralPercent: 0,
            attentionLevel: 'yellow',
            weeklyTrend: [],
            categoryBreakdown: [],
            isStale,
            collectedAt,
            noData: true
        };
    }

    const weeklyTrend = _computeWeeklyTrend(posts);
    const categoryBreakdown = _computeCategoryBreakdown(posts);

    // Attention level: stale overrides to yellow; otherwise driven by score
    let attentionLevel = _classifyAttentionLevel(sentiment.score);
    if (isStale) {
        attentionLevel = 'yellow';
    }

    return {
        score: sentiment.score,
        positivePercent: sentiment.positivePercent,
        negativePercent: sentiment.negativePercent,
        neutralPercent: sentiment.neutralPercent,
        attentionLevel,
        weeklyTrend,
        categoryBreakdown,
        isStale,
        collectedAt,
        noData: false
    };
}

/**
 * Apply a computed state to the DOM: update attention level and render content.
 * Stores the state as _lastGoodData for retention on future failures.
 */
function _applyState(state) {
    if (!_rootEl) return;

    // Update attention level on root element
    _rootEl.setAttribute('data-attention-level', state.attentionLevel);

    // Clear existing content and render new
    _rootEl.innerHTML = '';

    if (state.noData) {
        // Zero posts: render "No data" indicator
        const noData = document.createElement('div');
        noData.className = 'sentiment-no-data';
        noData.textContent = 'No data';
        _rootEl.appendChild(noData);
    } else {
        // Full render: score hero + trend + categories
        const cardContent = _renderCard(state);
        _rootEl.appendChild(cardContent);
    }

    // Store as last known good state
    _lastGoodData = state;
}

/**
 * Render an error state into the root element when initial load fails.
 * No prior content to retain — just the error indicator.
 */
function _renderErrorState(message) {
    if (!_rootEl) return;

    _rootEl.innerHTML = '';

    const errorEl = document.createElement('div');
    errorEl.className = 'sentiment-error';
    errorEl.setAttribute('role', 'alert');

    const icon = document.createElement('span');
    icon.className = 'sentiment-error-icon';
    icon.textContent = '⚠️';
    errorEl.appendChild(icon);

    const msg = document.createElement('span');
    msg.className = 'sentiment-error-message';
    msg.textContent = message;
    errorEl.appendChild(msg);

    _rootEl.appendChild(errorEl);
}

/**
 * Show refresh error indicator while retaining last good content.
 * If no prior successful render exists, shows error-only state.
 */
function _showRefreshError() {
    if (!_rootEl) return;

    // Remove any existing refresh error indicator
    const existing = _rootEl.querySelector('.sentiment-refresh-error');
    if (existing) existing.remove();

    // If we have last good data, retain it and prepend error indicator
    if (_lastGoodData) {
        // Re-render last good content with error banner on top
        _rootEl.innerHTML = '';

        const errorBanner = document.createElement('div');
        errorBanner.className = 'sentiment-refresh-error';
        errorBanner.setAttribute('role', 'alert');
        errorBanner.textContent = 'Update failed';
        _rootEl.appendChild(errorBanner);

        if (_lastGoodData.noData) {
            const noData = document.createElement('div');
            noData.className = 'sentiment-no-data';
            noData.textContent = 'No data';
            _rootEl.appendChild(noData);
        } else {
            const cardContent = _renderCard(_lastGoodData);
            _rootEl.appendChild(cardContent);
        }
    } else {
        // No prior content — show error-only state
        _renderErrorState('Data unavailable');
    }
}

// --- Core computation functions ---

/**
 * Compute net sentiment score from an array of posts.
 *
 * Formula: (positive_count / valid_total × 100) − (negative_count / valid_total × 100)
 * Posts with invalid sentiment values are excluded from both numerator and denominator.
 *
 * Returns { score, positivePercent, negativePercent, neutralPercent } where
 * percentages are integers summing to exactly 100 (rounding residual applied
 * to the largest group).
 *
 * Returns null if no posts have valid sentiment.
 */
export function _computeNetSentiment(posts) {
    if (!posts || posts.length === 0) return null;

    const validSentiments = ['positive', 'negative', 'neutral'];

    // Filter to posts with valid sentiment values only
    const validPosts = posts.filter(p => validSentiments.includes(p.sentiment));
    const total = validPosts.length;

    if (total === 0) return null;

    const posCount = validPosts.filter(p => p.sentiment === 'positive').length;
    const negCount = validPosts.filter(p => p.sentiment === 'negative').length;
    const neuCount = validPosts.filter(p => p.sentiment === 'neutral').length;

    // Net score: positive% minus negative%, rounded to one decimal
    const score = Math.round(((posCount / total) * 100 - (negCount / total) * 100) * 10) / 10;

    // Integer percentages that sum to exactly 100 via largest-remainder method
    const rawPos = (posCount / total) * 100;
    const rawNeg = (negCount / total) * 100;
    const rawNeu = (neuCount / total) * 100;

    // Floor each, then distribute the residual to the group(s) with the largest fractional part
    let floorPos = Math.floor(rawPos);
    let floorNeg = Math.floor(rawNeg);
    let floorNeu = Math.floor(rawNeu);

    let residual = 100 - (floorPos + floorNeg + floorNeu);

    // Build array of { index, fractional } to sort by descending fractional part,
    // with ties broken by descending raw value (largest group gets residual first)
    const fracs = [
        { idx: 0, frac: rawPos - floorPos, raw: rawPos },
        { idx: 1, frac: rawNeg - floorNeg, raw: rawNeg },
        { idx: 2, frac: rawNeu - floorNeu, raw: rawNeu }
    ];

    // Sort by fractional part descending; ties broken by raw value descending (largest group)
    fracs.sort((a, b) => {
        if (b.frac !== a.frac) return b.frac - a.frac;
        return b.raw - a.raw;
    });

    const results = [floorPos, floorNeg, floorNeu];
    for (let i = 0; i < residual; i++) {
        results[fracs[i].idx] += 1;
    }

    return {
        score,
        positivePercent: results[0],
        negativePercent: results[1],
        neutralPercent: results[2]
    };
}

/**
 * Format a net sentiment score for display.
 * Leading sign character: "+" for non-negative, "−" (U+2212) for negative.
 * Always one decimal digit. Examples: "+21.8", "−4.2", "+0.0"
 */
export function _formatScore(score) {
    const absVal = Math.abs(score).toFixed(1);
    if (score < 0) {
        return `\u2212${absVal}`;
    }
    return `+${absVal}`;
}

/**
 * Classify net sentiment score into attention level.
 * score ≥ +10 → "green"
 * −5 ≤ score < +10 → "yellow"
 * score < −5 → "red"
 */
export function _classifyAttentionLevel(score) {
    if (score >= 10) return 'green';
    if (score >= -5) return 'yellow';
    return 'red';
}

/**
 * Compute weekly trend data by grouping posts into ISO weeks (Monday–Sunday).
 *
 * Each post is assigned to the Monday of its ISO week based on created_at.
 * Per-week: positive% = positive / total × 100, negative% = negative / total × 100.
 * Weeks with zero posts get 0% for both.
 *
 * Returns array of WeekData objects sorted chronologically:
 * { weekLabel, positivePercent, negativePercent, totalPosts }
 *
 * weekLabel is the Monday date formatted as e.g. "May 5".
 */
export function _computeWeeklyTrend(posts) {
    if (!posts || posts.length === 0) return [];

    const validSentiments = ['positive', 'negative', 'neutral'];

    // Group posts by the Monday of their ISO week
    const weekMap = new Map(); // key: ISO date string of Monday, value: { pos, neg, total }

    for (const post of posts) {
        if (!post.created_at) continue;
        if (!validSentiments.includes(post.sentiment)) continue;

        const date = new Date(post.created_at);
        if (isNaN(date.getTime())) continue;

        const monday = _getMondayOfWeek(date);
        const key = monday.toISOString().split('T')[0]; // YYYY-MM-DD

        if (!weekMap.has(key)) {
            weekMap.set(key, { monday, pos: 0, neg: 0, total: 0 });
        }
        const bucket = weekMap.get(key);
        bucket.total += 1;
        if (post.sentiment === 'positive') bucket.pos += 1;
        if (post.sentiment === 'negative') bucket.neg += 1;
    }

    // Sort by date ascending and build WeekData array
    const sortedKeys = [...weekMap.keys()].sort();

    return sortedKeys.map(key => {
        const bucket = weekMap.get(key);
        const totalPosts = bucket.total;
        const positivePercent = totalPosts > 0 ? Math.round((bucket.pos / totalPosts) * 100) : 0;
        const negativePercent = totalPosts > 0 ? Math.round((bucket.neg / totalPosts) * 100) : 0;

        // Format weekLabel as "Mon D" e.g. "May 5"
        const weekLabel = _formatWeekLabel(bucket.monday);

        return { weekLabel, positivePercent, negativePercent, totalPosts };
    });
}

/**
 * Get the Monday of the ISO week for a given date.
 * ISO weeks start on Monday. getDay() returns 0=Sun, 1=Mon, ..., 6=Sat.
 */
function _getMondayOfWeek(date) {
    const d = new Date(date);
    const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    // Offset to get back to Monday: if Sunday (0), go back 6 days; otherwise go back (day - 1) days
    const diff = day === 0 ? 6 : day - 1;
    d.setUTCDate(d.getUTCDate() - diff);
    // Zero out time to get clean midnight Monday
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/**
 * Format a Monday date as a short label: "May 5", "Jun 2", etc.
 */
function _formatWeekLabel(monday) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[monday.getUTCMonth()]} ${monday.getUTCDate()}`;
}

/**
 * Compute category breakdown from posts.
 *
 * For each category bucket that has at least one post:
 * - Count total, positive, neutral, negative posts
 * - Compute proportions as percentages
 * - Compute negative ratio (negative / total) for sorting
 *
 * Sort by descending negative ratio; ties broken by descending total count.
 * Buckets with zero posts are omitted.
 *
 * Returns array of CategoryRow objects:
 * { name, totalPosts, positivePercent, neutralPercent, negativePercent, negativeRatio }
 */
export function _computeCategoryBreakdown(posts) {
    if (!posts || posts.length === 0) return [];

    const validSentiments = ['positive', 'negative', 'neutral'];
    const buckets = new Map(); // category name → { pos, neg, neu, total }

    for (const post of posts) {
        if (!post.category) continue;
        if (!validSentiments.includes(post.sentiment)) continue;

        if (!buckets.has(post.category)) {
            buckets.set(post.category, { pos: 0, neg: 0, neu: 0, total: 0 });
        }
        const b = buckets.get(post.category);
        b.total += 1;
        if (post.sentiment === 'positive') b.pos += 1;
        else if (post.sentiment === 'negative') b.neg += 1;
        else b.neu += 1;
    }

    // Build CategoryRow array, omit zero-post buckets
    const rows = [];
    for (const [name, b] of buckets) {
        if (b.total === 0) continue;
        rows.push({
            name,
            totalPosts: b.total,
            positivePercent: Math.round((b.pos / b.total) * 100),
            neutralPercent: Math.round((b.neu / b.total) * 100),
            negativePercent: Math.round((b.neg / b.total) * 100),
            negativeRatio: b.neg / b.total
        });
    }

    // Sort by descending negative ratio; ties broken by descending total count
    rows.sort((a, b) => {
        if (b.negativeRatio !== a.negativeRatio) return b.negativeRatio - a.negativeRatio;
        return b.totalPosts - a.totalPosts;
    });

    return rows;
}

/**
 * Check if collected_at timestamp indicates stale data.
 * Returns true if the timestamp is more than 336 hours (14 days) from current UTC.
 */
export function _checkStaleness(collectedAt) {
    if (!collectedAt) return true;

    const collected = new Date(collectedAt);
    if (isNaN(collected.getTime())) return true;

    const now = new Date();
    const diffMs = now.getTime() - collected.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);

    return diffHours > 336;
}

/**
 * Fetch Reddit data via manifest resolution.
 *
 * Steps:
 * 1. Fetch data/manifest.json (fallback to ../data/manifest.json)
 * 2. Extract collectors.reddit.latest path
 * 3. Fetch the reddit JSON file at that path
 * 4. Parse and return the envelope
 *
 * Signals data-unavailable (throws) if:
 * - Manifest is unreachable or malformed JSON
 * - collectors.reddit key is missing from manifest
 * - collectors.reddit.latest is absent or empty
 * - Reddit JSON file fetch fails or times out (10s)
 * - Reddit JSON is malformed or missing data.posts
 *
 * Uses AbortController pattern with 10-second timeout.
 */
export async function _fetchRedditData() {
    // Create abort controller with 10s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    _abortController = controller;

    try {
        // Step 1: Fetch and parse manifest
        const manifest = await _fetchManifest(controller.signal);

        // Step 2: Extract reddit path from manifest
        const redditPath = _resolveRedditPath(manifest);

        // Step 3: Fetch the reddit data file
        const data = await _fetchRedditFile(redditPath, controller.signal);

        return data;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetch manifest.json, trying both path variants.
 * Throws on network failure or malformed JSON.
 */
async function _fetchManifest(signal) {
    let resp;
    try {
        resp = await fetch('data/manifest.json', { signal });
    } catch (err) {
        // If aborted, rethrow; otherwise try alternate path
        if (err.name === 'AbortError') throw new Error('Fetch timeout');
        try {
            resp = await fetch('../data/manifest.json', { signal });
        } catch (err2) {
            if (err2.name === 'AbortError') throw new Error('Fetch timeout');
            throw new Error('Manifest unreachable');
        }
    }

    if (!resp || !resp.ok) {
        // Try alternate path if first returned non-ok
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
 * Extract the reddit data file path from a parsed manifest object.
 * Throws if collectors.reddit is missing or latest is absent/empty.
 */
export function _resolveRedditPath(manifest) {
    if (!manifest || !manifest.collectors || !manifest.collectors.reddit) {
        throw new Error('Reddit entry missing from manifest');
    }

    const latest = manifest.collectors.reddit.latest;
    if (!latest || typeof latest !== 'string' || latest.trim() === '') {
        throw new Error('Reddit latest path missing from manifest');
    }

    return latest;
}

// --- Rendering functions ---

/**
 * Render the full sentiment card DOM from computed state.
 *
 * Assembles: score hero (formatted net score + distribution chips),
 * trend SVG chart, and category breakdown rows.
 * All DOM built programmatically via createElement — no innerHTML with user data.
 *
 * @param {object} data - Computed SentimentState: { score, positivePercent, negativePercent,
 *   neutralPercent, attentionLevel, weeklyTrend, categoryBreakdown, isStale, collectedAt }
 * @returns {HTMLElement} The assembled card content container
 */
export function _renderCard(data) {
    const card = document.createElement('div');
    card.className = 'sentiment-card-content';

    // Score hero section: large formatted score + title + distribution chips
    const hero = document.createElement('div');
    hero.className = 'sentiment-hero';

    const scoreEl = document.createElement('span');
    scoreEl.className = 'sentiment-score';
    scoreEl.textContent = _formatScore(data.score);
    hero.appendChild(scoreEl);

    const labelBlock = document.createElement('div');
    labelBlock.className = 'sentiment-label';

    const title = document.createElement('span');
    title.className = 'sentiment-title';
    title.textContent = 'Net Sentiment';
    labelBlock.appendChild(title);

    // Distribution chips: "29% pos · 7% neg · 64% neu"
    const chips = document.createElement('div');
    chips.className = 'sentiment-chips';

    const posChip = document.createElement('span');
    posChip.className = 'sentiment-chip sentiment-chip-pos';
    posChip.textContent = `${data.positivePercent}% pos`;
    chips.appendChild(posChip);

    const sep1 = document.createElement('span');
    sep1.className = 'sentiment-chip-separator';
    sep1.textContent = '·';
    chips.appendChild(sep1);

    const negChip = document.createElement('span');
    negChip.className = 'sentiment-chip sentiment-chip-neg';
    negChip.textContent = `${data.negativePercent}% neg`;
    chips.appendChild(negChip);

    const sep2 = document.createElement('span');
    sep2.className = 'sentiment-chip-separator';
    sep2.textContent = '·';
    chips.appendChild(sep2);

    const neuChip = document.createElement('span');
    neuChip.className = 'sentiment-chip';
    neuChip.textContent = `${data.neutralPercent}% neu`;
    chips.appendChild(neuChip);

    labelBlock.appendChild(chips);
    hero.appendChild(labelBlock);
    card.appendChild(hero);

    // Stale data badge — shown above trend if data is old
    if (data.isStale) {
        const staleBadge = document.createElement('span');
        staleBadge.className = 'sentiment-stale-badge';
        staleBadge.textContent = 'Stale data';
        card.appendChild(staleBadge);
    }

    // Trend chart section
    const trendContainer = document.createElement('div');
    trendContainer.className = 'sentiment-trend';
    const trendContent = _renderTrendChart(data.weeklyTrend);
    trendContainer.appendChild(trendContent);
    card.appendChild(trendContainer);

    // Category breakdown rows
    const categoriesContainer = _renderCategoryRows(data.categoryBreakdown);
    card.appendChild(categoriesContainer);

    return card;
}

/**
 * Render the SVG trend chart with two polylines: positive and negative sentiment per week.
 *
 * Positive line uses --grade-a, negative uses --grade-f.
 * Y-axis fixed 0–100%. X-axis shows week labels (Monday date).
 * Max 120px height. If < 2 weeks of data, shows "Insufficient history" instead.
 *
 * @param {Array} weeklyData - Array of WeekData: { weekLabel, positivePercent, negativePercent, totalPosts }
 * @returns {HTMLElement} Either an SVG element or a placeholder div
 */
export function _renderTrendChart(weeklyData) {
    // Insufficient data: need at least 2 weeks to draw a line
    if (!weeklyData || weeklyData.length < 2) {
        const empty = document.createElement('div');
        empty.className = 'sentiment-trend-empty';
        empty.textContent = 'Insufficient history';
        return empty;
    }

    // SVG dimensions — width flexible (viewBox scales), height capped at 120px
    const svgWidth = 300;
    const svgHeight = 100;
    const paddingLeft = 5;
    const paddingRight = 5;
    const paddingTop = 8;
    const paddingBottom = 20; // Room for X-axis week labels
    const drawWidth = svgWidth - paddingLeft - paddingRight;
    const drawHeight = svgHeight - paddingTop - paddingBottom;

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-label', 'Sentiment trend chart');
    svg.setAttribute('role', 'img');

    const numPoints = weeklyData.length;

    // Compute X positions evenly spaced across draw area
    const xPositions = weeklyData.map((_, i) => {
        if (numPoints === 1) return paddingLeft + drawWidth / 2;
        return paddingLeft + (i / (numPoints - 1)) * drawWidth;
    });

    // Build polyline points for positive and negative lines
    // Y-axis: 0% at bottom (paddingTop + drawHeight), 100% at top (paddingTop)
    const posPoints = weeklyData.map((w, i) => {
        const x = xPositions[i];
        const y = paddingTop + drawHeight - (w.positivePercent / 100) * drawHeight;
        return `${x},${y}`;
    }).join(' ');

    const negPoints = weeklyData.map((w, i) => {
        const x = xPositions[i];
        const y = paddingTop + drawHeight - (w.negativePercent / 100) * drawHeight;
        return `${x},${y}`;
    }).join(' ');

    // Positive line (--grade-a)
    const posLine = document.createElementNS(svgNS, 'polyline');
    posLine.setAttribute('points', posPoints);
    posLine.setAttribute('fill', 'none');
    posLine.setAttribute('stroke', 'var(--grade-a)');
    posLine.setAttribute('stroke-width', '2');
    posLine.setAttribute('stroke-linecap', 'round');
    posLine.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(posLine);

    // Negative line (--grade-f)
    const negLine = document.createElementNS(svgNS, 'polyline');
    negLine.setAttribute('points', negPoints);
    negLine.setAttribute('fill', 'none');
    negLine.setAttribute('stroke', 'var(--grade-f)');
    negLine.setAttribute('stroke-width', '2');
    negLine.setAttribute('stroke-linecap', 'round');
    negLine.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(negLine);

    // X-axis week labels beneath each data point
    weeklyData.forEach((w, i) => {
        const label = document.createElementNS(svgNS, 'text');
        label.setAttribute('x', String(xPositions[i]));
        label.setAttribute('y', String(svgHeight - 2));
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('font-size', '9');
        label.setAttribute('fill', 'var(--text-muted)');
        label.textContent = w.weekLabel;
        svg.appendChild(label);
    });

    return svg;
}

/**
 * Render category breakdown rows as stacked horizontal bars.
 *
 * Max 5 rows displayed. If more than 5 populated categories, appends "+N more".
 * Single-bucket edge case: name + count only, no bar (no comparative context).
 * Segments use design tokens: positive=--grade-a, neutral=--border, negative=--grade-f.
 *
 * @param {Array} breakdown - Array of CategoryRow sorted by negative ratio descending
 * @returns {HTMLElement} Container div with category rows
 */
export function _renderCategoryRows(breakdown) {
    const container = document.createElement('div');
    container.className = 'sentiment-categories';

    if (!breakdown || breakdown.length === 0) return container;

    // Single-bucket case: show name + count without bar (no comparative context)
    if (breakdown.length === 1) {
        const solo = document.createElement('div');
        solo.className = 'sentiment-category-solo';

        const name = document.createElement('span');
        name.className = 'sentiment-category-name';
        name.textContent = breakdown[0].name;
        solo.appendChild(name);

        const count = document.createElement('span');
        count.className = 'sentiment-category-count';
        count.textContent = `${breakdown[0].totalPosts} posts`;
        solo.appendChild(count);

        container.appendChild(solo);
        return container;
    }

    // Multi-bucket case: show up to 3 rows with stacked bars
    // (compact layout — center overlay has limited vertical space)
    const maxVisible = 3;
    const visibleRows = breakdown.slice(0, maxVisible);

    for (const row of visibleRows) {
        const rowEl = document.createElement('div');
        rowEl.className = 'sentiment-category-row';

        // Header line: name + count
        const header = document.createElement('div');
        header.className = 'sentiment-category-header';

        const nameEl = document.createElement('span');
        nameEl.className = 'sentiment-category-name';
        nameEl.textContent = row.name;
        header.appendChild(nameEl);

        const countEl = document.createElement('span');
        countEl.className = 'sentiment-category-count';
        countEl.textContent = `${row.totalPosts}`;
        header.appendChild(countEl);

        rowEl.appendChild(header);

        // Stacked bar: three segments proportional to sentiment distribution
        const bar = document.createElement('div');
        bar.className = 'sentiment-bar';

        if (row.positivePercent > 0) {
            const posSeg = document.createElement('div');
            posSeg.className = 'sentiment-bar-pos';
            posSeg.style.width = `${row.positivePercent}%`;
            bar.appendChild(posSeg);
        }

        if (row.neutralPercent > 0) {
            const neuSeg = document.createElement('div');
            neuSeg.className = 'sentiment-bar-neu';
            neuSeg.style.width = `${row.neutralPercent}%`;
            bar.appendChild(neuSeg);
        }

        if (row.negativePercent > 0) {
            const negSeg = document.createElement('div');
            negSeg.className = 'sentiment-bar-neg';
            negSeg.style.width = `${row.negativePercent}%`;
            bar.appendChild(negSeg);
        }

        rowEl.appendChild(bar);
        container.appendChild(rowEl);
    }

    // "+N more" truncation indicator with hover popup showing hidden categories
    if (breakdown.length > maxVisible) {
        const hiddenRows = breakdown.slice(maxVisible);
        const moreWrapper = document.createElement('div');
        moreWrapper.className = 'sentiment-more-wrapper';

        const more = document.createElement('div');
        more.className = 'sentiment-more-indicator';
        more.textContent = `+${hiddenRows.length} more`;
        moreWrapper.appendChild(more);

        // Popup: shows all hidden categories with their bars on hover
        // Uses position:fixed + JS positioning to escape all overflow constraints
        const popup = document.createElement('div');
        popup.className = 'sentiment-more-popup';

        for (const row of hiddenRows) {
            const popupRow = document.createElement('div');
            popupRow.className = 'sentiment-popup-row';

            // Header: name + count on one line
            const header = document.createElement('div');
            header.className = 'sentiment-popup-header';

            const nameEl = document.createElement('span');
            nameEl.className = 'sentiment-popup-name';
            nameEl.textContent = row.name;
            header.appendChild(nameEl);

            const countEl = document.createElement('span');
            countEl.className = 'sentiment-popup-count';
            countEl.textContent = `${row.totalPosts}`;
            header.appendChild(countEl);

            popupRow.appendChild(header);

            const bar = document.createElement('div');
            bar.className = 'sentiment-bar';

            if (row.positivePercent > 0) {
                const posSeg = document.createElement('div');
                posSeg.className = 'sentiment-bar-pos';
                posSeg.style.width = `${row.positivePercent}%`;
                bar.appendChild(posSeg);
            }
            if (row.neutralPercent > 0) {
                const neuSeg = document.createElement('div');
                neuSeg.className = 'sentiment-bar-neu';
                neuSeg.style.width = `${row.neutralPercent}%`;
                bar.appendChild(neuSeg);
            }
            if (row.negativePercent > 0) {
                const negSeg = document.createElement('div');
                negSeg.className = 'sentiment-bar-neg';
                negSeg.style.width = `${row.negativePercent}%`;
                bar.appendChild(negSeg);
            }

            popupRow.appendChild(bar);
            popup.appendChild(popupRow);
        }

        // Portal popup to document.body to escape all overflow clipping
        popup.className = 'sentiment-more-popup-portal';
        document.body.appendChild(popup);

        // Show/hide and position on hover
        moreWrapper.addEventListener('mouseenter', () => {
            const rect = more.getBoundingClientRect();
            popup.classList.add('visible');

            // Measure popup now that it's visible
            const popupRect = popup.getBoundingClientRect();
            const popupHeight = popupRect.height;

            // Center horizontally over the "+N more" text
            let left = rect.left + rect.width / 2 - 170;
            let top = rect.top - popupHeight - 8;

            // Clamp to viewport
            if (left < 8) left = 8;
            if (left + 340 > window.innerWidth - 8) left = window.innerWidth - 348;
            if (top < 8) top = rect.bottom + 8;

            popup.style.left = `${left}px`;
            popup.style.top = `${top}px`;
        });

        moreWrapper.addEventListener('mouseleave', (e) => {
            // Check if mouse moved to the popup itself
            const related = e.relatedTarget;
            if (popup.contains(related)) return;
            popup.classList.remove('visible');
        });

        popup.addEventListener('mouseleave', (e) => {
            const related = e.relatedTarget;
            if (moreWrapper.contains(related)) return;
            popup.classList.remove('visible');
        });

        container.appendChild(moreWrapper);
    }

    return container;
}

/**
 * Fetch and parse the reddit JSON file. Tries path as-is, then with ../ prefix.
 * Validates that data.posts exists as an array.
 */
async function _fetchRedditFile(path, signal) {
    let resp;
    try {
        resp = await fetch(path, { signal });
        if (!resp.ok) {
            resp = await fetch(`../${path}`, { signal });
        }
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Fetch timeout');
        // Try alternate path prefix
        try {
            resp = await fetch(`../${path}`, { signal });
        } catch (err2) {
            if (err2.name === 'AbortError') throw new Error('Fetch timeout');
            throw new Error('Reddit data file unreachable');
        }
    }

    if (!resp || !resp.ok) {
        throw new Error('Reddit data file unreachable');
    }

    let json;
    try {
        json = await resp.json();
    } catch {
        throw new Error('Reddit data malformed JSON');
    }

    // Validate required structure
    if (!json.data || !Array.isArray(json.data.posts)) {
        throw new Error('Reddit data missing data.posts array');
    }

    return json;
}
