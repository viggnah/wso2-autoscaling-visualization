// components/StatusChart.tsx
"use client";

import React from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, TooltipProps
} from 'recharts';
import { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

interface ChartDataPoint {
    timestamp: string; // Full ISO string for potential future use
    timeLabel: string; // Formatted time for X-axis
    activePods?: number;
    totalCpuMillicores?: number;
    // Add other metrics like desiredReplicas if needed
}

interface StatusChartProps {
    data: ChartDataPoint[];
    metric: 'activePods' | 'totalCpuMillicores';
    title: string;
    lineColor: string;
    yAxisLabel?: string;
    yAxisDomain?: [number | string, number | string]; // For custom domain e.g. [0, 'dataMax + 100']
}

// Custom Tooltip
const CustomTooltip = ({ active, payload, label }: TooltipProps<ValueType, NameType>) => {
    if (active && payload && payload.length) {
    return (
        <div className="bg-slate-700/90 p-3 rounded-md shadow-lg border border-slate-600">
        <p className="text-sm text-sky-300">{`Time: ${label}`}</p>
        {payload.map((pld, index) => (
            <p key={index} style={{ color: pld.color }} className="text-sm">
            {`${pld.name}: ${pld.value?.toLocaleString()}${pld.dataKey === 'totalCpuMillicores' ? 'm' : ''}`}
            </p>
        ))}
        </div>
    );
    }
    return null;
};


const StatusChart: React.FC<StatusChartProps> = ({ data, metric, title, lineColor, yAxisLabel, yAxisDomain }) => {
    if (!data || data.length === 0) {
    return <div className="text-slate-400 text-center py-10">No data available for {title}.</div>;
    }

    return (
    <div className="h-72 md:h-80 bg-slate-800 p-4 rounded-lg shadow-xl border border-slate-700">
        <h3 className="text-lg font-semibold text-sky-400 mb-4 text-center">{title}</h3>
        <ResponsiveContainer width="100%" height="100%">
        <LineChart
            data={data}
            margin={{
            top: 5, right: 30, left: 20, bottom: 25, // Increased bottom margin for labels
            }}
        >
            <CartesianGrid strokeDasharray="3 3" stroke="#475569" />
            <XAxis 
            dataKey="timeLabel" 
            stroke="#94a3b8" 
            tick={{ fontSize: 10 }}
            angle={-30} // Angle labels to prevent overlap
            textAnchor="end" // Anchor angled labels correctly
            height={50} // Allocate more height for XAxis if labels are long/angled
            />
            <YAxis 
            stroke="#94a3b8" 
            tick={{ fontSize: 10 }} 
            label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 12, dy: 40 } : undefined}
            domain={yAxisDomain || ['auto', 'auto']} // Default domain or custom
            allowDecimals={metric === 'activePods' ? false : true}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: "12px", paddingTop: "10px" }} />
            <Line
            type="monotone"
            dataKey={metric}
            name={metric === 'activePods' ? "Active Pods" : "Total CPU (millicores)"}
            stroke={lineColor}
            strokeWidth={2}
            dot={{ r: 3, strokeWidth: 1, fill: lineColor }}
            activeDot={{ r: 6, strokeWidth: 1, fill: lineColor }}
            />
        </LineChart>
        </ResponsiveContainer>
    </div>
    );
};

export default StatusChart;
