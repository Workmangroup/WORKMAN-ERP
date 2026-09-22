"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export const WM = {
  blue: "#0b3d91",
  yellow: "#ffc20e",
  sky: "#3b82f6",
  slate: "#94a3b8",
  orange: "#f97316",
  green: "#10b981",
  violet: "#8b5cf6",
  red: "#dc2626",
};
export const PALETTE = [WM.blue, WM.yellow, WM.sky, WM.orange, WM.green, WM.violet, WM.slate, WM.red];

const axis = { fontSize: 12, fill: "#64748b" };
const tooltipStyle = {
  contentStyle: { borderRadius: 10, border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgba(15,23,42,.08)", fontSize: 13 },
  cursor: { fill: "rgba(11,61,145,0.05)" },
};

export function ChartCard({ title, subtitle, children, className = "" }: { title: string; subtitle?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border bg-card p-5 shadow-xs ${className}`}>
      <h3 className="font-semibold text-slate-900">{title}</h3>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function ChartEmpty() {
  return <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">Aucune donnée sur la période</div>;
}

/** Barres horizontales (classements : par service, par type…). */
export function HBarChart({ data, labelKey, valueKey = "total", color = WM.blue, height }: {
  data: Record<string, unknown>[];
  labelKey: string;
  valueKey?: string;
  color?: string;
  height?: number;
}) {
  if (!data.length) return <ChartEmpty />;
  return (
    <ResponsiveContainer width="100%" height={height ?? Math.max(220, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid horizontal={false} stroke="#eef2f7" />
        <XAxis type="number" allowDecimals={false} tick={axis} axisLine={false} tickLine={false} />
        <YAxis type="category" dataKey={labelKey} width={150} tick={axis} axisLine={false} tickLine={false} />
        <Tooltip {...tooltipStyle} formatter={(v) => [v, "Total"]} />
        <Bar dataKey={valueKey} fill={color} radius={[0, 6, 6, 0]} barSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Anneau de répartition avec légende. */
export function DonutChart({ data, labelKey, valueKey = "total", height = 280 }: {
  data: Record<string, unknown>[];
  labelKey: string;
  valueKey?: string;
  height?: number;
}) {
  if (!data.length) return <ChartEmpty />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey={valueKey} nameKey={labelKey} innerRadius="55%" outerRadius="85%" paddingAngle={2} stroke="#fff">
          {data.map((_, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Tooltip {...tooltipStyle} />
        <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** Séries temporelles (aires superposées). */
export function TrendChart({ data, xKey, series, height = 280, unit }: {
  data: Record<string, unknown>[];
  xKey: string;
  series: { key: string; label: string; color: string }[];
  height?: number;
  unit?: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ left: -12, right: 8 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="#eef2f7" />
        <XAxis dataKey={xKey} tick={axis} axisLine={false} tickLine={false} />
        <YAxis allowDecimals={false} tick={axis} axisLine={false} tickLine={false} />
        <Tooltip {...tooltipStyle} formatter={(v, name) => [v === null ? "—" : `${v}${unit ?? ""}`, name]} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        {series.map((s) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2.5} fill={`url(#g-${s.key})`} connectNulls dot={{ r: 3, strokeWidth: 0, fill: s.color }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Barres groupées verticales. */
export function GroupedBarChart({ data, xKey, series, height = 280, unit, stacked = false }: {
  data: Record<string, unknown>[];
  xKey: string;
  series: { key: string; label: string; color: string }[];
  height?: number;
  unit?: string;
  stacked?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ left: -12, right: 8 }}>
        <CartesianGrid vertical={false} stroke="#eef2f7" />
        <XAxis dataKey={xKey} tick={axis} axisLine={false} tickLine={false} />
        <YAxis tick={axis} axisLine={false} tickLine={false} />
        <Tooltip {...tooltipStyle} formatter={(v, name) => [v === null ? "—" : `${v}${unit ?? ""}`, name]} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={s.color}
            stackId={stacked ? "a" : undefined}
            radius={stacked ? (i === series.length - 1 ? [5, 5, 0, 0] : [0, 0, 0, 0]) : [5, 5, 0, 0]}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
