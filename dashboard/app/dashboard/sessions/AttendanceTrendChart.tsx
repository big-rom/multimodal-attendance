"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type SessionData = {
  id: string;
  starts_at: string;
  attendance_count: number;
};

export default function AttendanceTrendChart({
  sessions,
  totalEnrolled,
}: {
  sessions: SessionData[];
  totalEnrolled: number;
}) {
  const chartData = useMemo(() => {
    // Sort sessions chronologically (oldest to newest) for the chart
    const sorted = [...sessions].sort(
      (a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()
    );

    return sorted.map((s, index) => {
      const percentage = totalEnrolled > 0 ? (s.attendance_count / totalEnrolled) * 100 : 0;
      return {
        name: `Session ${index + 1}`,
        date: new Date(s.starts_at).toLocaleDateString(),
        percentage: Number(percentage.toFixed(1)),
        count: s.attendance_count,
      };
    });
  }, [sessions, totalEnrolled]);

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
      <h3 className="text-sm font-bold text-slate-900 mb-4 uppercase tracking-wider">
        Attendance Trend
      </h3>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis 
              dataKey="name" 
              axisLine={false} 
              tickLine={false} 
              tick={{ fontSize: 12, fill: "#64748b" }} 
              dy={10}
            />
            <YAxis
              axisLine={false}
              tickLine={false}
              tick={{ fontSize: 12, fill: "#64748b" }}
              domain={[0, 100]}
              tickFormatter={(val) => `${val}%`}
            />
            <Tooltip
              contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
              formatter={(value: any, name: any) => [
                `${value}% (${
                  chartData.find((d) => d.percentage === value)?.count || 0
                }/${totalEnrolled})`,
                "Attended",
              ]}
              labelStyle={{ color: "#0f172a", fontWeight: "bold", marginBottom: "4px" }}
            />
            <Line
              type="monotone"
              dataKey="percentage"
              stroke="#4f46e5"
              strokeWidth={3}
              dot={{ r: 4, fill: "#4f46e5", strokeWidth: 2, stroke: "#fff" }}
              activeDot={{ r: 6, fill: "#4f46e5", stroke: "#fff" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
