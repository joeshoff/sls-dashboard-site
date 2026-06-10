/**
 * operations-charts.js — ECharts configuration builders.
 *
 * Each function returns an ECharts option object. No DOM manipulation —
 * the caller passes the returned option to echarts.setOption().
 *
 * Dark theme colors match CSS custom properties in variables.css.
 * ECharts is loaded via CDN (global `echarts` object); this module
 * only exports pure option-builder functions.
 */

// Shared color palette matching the dashboard's dark theme
const CHART_COLORS = {
    primary: '#6c8cff',
    secondary: '#9898b0',
    grid: '#3a3a5a',
    text: '#9898b0',
    background: 'transparent',
    sev1: '#c92e2e',
    sev2: '#c95e2e',
    sev3: '#c9922e',
    sev4: '#9898b0'
};

// Tooltip styling consistent across all charts
const TOOLTIP_STYLE = {
    trigger: 'axis',
    backgroundColor: '#222240',
    borderColor: '#3a3a5a',
    textStyle: { color: '#e8e8f0', fontSize: 12 }
};

/**
 * FSI composite trend line chart.
 * Y-axis fixed 0-100 (lower is better). X-axis: week-ending dates.
 * Smooth line with subtle area fill.
 *
 * @param {Array<{weekEnding: string, score: number}>} dataPoints
 * @returns {Object} ECharts option object
 */
export function buildFSITrendChart(dataPoints) {
    return {
        grid: { left: 40, right: 16, top: 16, bottom: 32 },
        xAxis: {
            type: 'category',
            data: dataPoints.map(d => d.weekEnding),
            axisLabel: { color: CHART_COLORS.text, fontSize: 10 },
            axisLine: { lineStyle: { color: CHART_COLORS.grid } }
        },
        yAxis: {
            type: 'value',
            min: 0,
            max: 100,
            axisLabel: { color: CHART_COLORS.text, fontSize: 10 },
            splitLine: { lineStyle: { color: CHART_COLORS.grid, opacity: 0.3 } }
        },
        series: [{
            type: 'line',
            data: dataPoints.map(d => d.score),
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            lineStyle: { color: CHART_COLORS.primary, width: 2 },
            itemStyle: { color: CHART_COLORS.primary },
            areaStyle: { color: 'rgba(108, 140, 255, 0.08)' }
        }],
        tooltip: { ...TOOLTIP_STYLE }
    };
}

/**
 * Incident volume + MTTR dual-axis chart.
 * Left Y-axis: incident count (bar). Right Y-axis: MTTR hours (line).
 * Null MTTR values produce gaps in the line — connectNulls is false.
 *
 * @param {Array<{weekEnding: string, count: number, mttr: number|null}>} weeklyData
 * @returns {Object} ECharts option object
 */
export function buildIncidentTrendChart(weeklyData) {
    return {
        grid: { left: 48, right: 48, top: 16, bottom: 32 },
        xAxis: {
            type: 'category',
            data: weeklyData.map(d => d.weekEnding),
            axisLabel: { color: CHART_COLORS.text, fontSize: 10 },
            axisLine: { lineStyle: { color: CHART_COLORS.grid } }
        },
        yAxis: [
            // Left axis: incident volume
            {
                type: 'value',
                name: 'Incidents',
                nameTextStyle: { color: CHART_COLORS.text, fontSize: 10 },
                axisLabel: { color: CHART_COLORS.text, fontSize: 10 },
                splitLine: { lineStyle: { color: CHART_COLORS.grid, opacity: 0.3 } }
            },
            // Right axis: MTTR in hours
            {
                type: 'value',
                name: 'Hours',
                nameTextStyle: { color: CHART_COLORS.text, fontSize: 10 },
                axisLabel: { color: CHART_COLORS.text, fontSize: 10 },
                splitLine: { show: false }
            }
        ],
        series: [
            {
                name: 'Volume',
                type: 'bar',
                yAxisIndex: 0,
                data: weeklyData.map(d => d.count),
                itemStyle: { color: 'rgba(108, 140, 255, 0.6)', borderRadius: [3, 3, 0, 0] }
            },
            {
                name: 'MTTR',
                type: 'line',
                yAxisIndex: 1,
                data: weeklyData.map(d => d.mttr),
                smooth: true,
                symbol: 'circle',
                symbolSize: 5,
                lineStyle: { color: '#c9922e', width: 2 },
                itemStyle: { color: '#c9922e' },
                connectNulls: false // gaps where MTTR is null
            }
        ],
        tooltip: { ...TOOLTIP_STYLE }
    };
}

/**
 * ETRC grade trend chart (team view).
 * Y-axis: grade scale (F=1, D=2, C=3, B=4, A=5) with letter labels.
 * Not smooth — grade changes are discrete steps.
 *
 * @param {Array<{weekEnding: string, grade: string}>} dataPoints
 * @returns {Object} ECharts option object
 */
export function buildETRCTrendChart(dataPoints) {
    // Map letter grades to numeric values for the Y-axis
    const gradeToNum = { F: 1, D: 2, C: 3, B: 4, A: 5 };

    return {
        grid: { left: 40, right: 16, top: 16, bottom: 32 },
        xAxis: {
            type: 'category',
            data: dataPoints.map(d => d.weekEnding),
            axisLabel: { color: CHART_COLORS.text, fontSize: 10 },
            axisLine: { lineStyle: { color: CHART_COLORS.grid } }
        },
        yAxis: {
            type: 'value',
            min: 1,
            max: 5,
            interval: 1,
            axisLabel: {
                color: CHART_COLORS.text,
                fontSize: 10,
                // Display letter grades instead of numbers on the Y-axis
                formatter: v => ({ 1: 'F', 2: 'D', 3: 'C', 4: 'B', 5: 'A' }[v] || '')
            },
            splitLine: { lineStyle: { color: CHART_COLORS.grid, opacity: 0.3 } }
        },
        series: [{
            type: 'line',
            data: dataPoints.map(d => gradeToNum[d.grade] || null),
            smooth: false,
            symbol: 'circle',
            symbolSize: 8,
            lineStyle: { color: CHART_COLORS.primary, width: 2 },
            itemStyle: { color: CHART_COLORS.primary }
        }],
        tooltip: { ...TOOLTIP_STYLE }
    };
}
