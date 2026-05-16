// Extension: ot-salary-optimizer
// OT schedule optimizer for DokoKin/FJP — maximizes monthly salary.

import { execFile } from "node:child_process";
import { joinSession } from "@github/copilot-sdk/extension";

const SCRIPT_DIR = "C:\\Users\\Admin\\Downloads\\FJP Tool\\FJP Tool\\scripts";
const SCRIPT = `${SCRIPT_DIR}\\ot_optimizer.py`;
const PYTHON = "C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

function run(args) {
    return new Promise((resolve) => {
        execFile(PYTHON, [SCRIPT, ...args], { cwd: SCRIPT_DIR, timeout: 30000 }, (err, stdout, stderr) => {
            if (err) resolve(`Error (exit ${err.code}): ${stderr || err.message}\n${stdout}`);
            else resolve(stdout || "(no output)");
        });
    });
}

const session = await joinSession({
    tools: [
        {
            name: "ot_rates",
            description: "Xem bảng rate OT thực tế (từ payslip). Sunday Night 160%, Any Night 150%, Sunday Day 135%, Weekday/Saturday 125%.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => run(["rates"]),
        },
        {
            name: "ot_timesheet",
            description: "Lấy timesheet tháng hiện tại hoặc chỉ định (year, month). Hiển thị tổng giờ làm, OT, đêm, trạng thái.",
            parameters: {
                type: "object",
                properties: {
                    year: { type: "number", description: "Năm (default: năm hiện tại)" },
                    month: { type: "number", description: "Tháng (default: tháng hiện tại)" },
                },
            },
            skipPermission: true,
            handler: async ({ year, month }) => {
                const args = ["timesheet"];
                if (year) args.push("--year", String(year));
                if (month) args.push("--month", String(month));
                return run(args);
            },
        },
        {
            name: "ot_requests",
            description: "Lấy danh sách OT request trong tháng. Hiển thị ngày, giờ, trạng thái (Submitted/Approved/Rejected).",
            parameters: {
                type: "object",
                properties: {
                    year: { type: "number" },
                    month: { type: "number" },
                },
            },
            skipPermission: true,
            handler: async ({ year, month }) => {
                const args = ["ot-requests"];
                if (year) args.push("--year", String(year));
                if (month) args.push("--month", String(month));
                return run(args);
            },
        },
        {
            name: "ot_optimize",
            description: "Tính toán lịch OT tối ưu để đạt lương cao nhất. Ưu tiên: Sunday Night > Any Night > Sunday Day > Weekday Day. Giữ lại request đã tạo cho ngày trong quá khứ.",
            parameters: {
                type: "object",
                properties: {
                    year: { type: "number" },
                    month: { type: "number" },
                    cap: { type: "number", description: "Max OT hours/month (default: 75)" },
                    max_day: { type: "number", description: "Max OT hours/day (default: 12)" },
                    end_time: { type: "string", description: "Preferred shift end time HH:MM (default: 03:30)" },
                },
            },
            skipPermission: true,
            handler: async ({ year, month, cap, max_day, end_time }) => {
                const args = ["optimize"];
                if (year) args.push("--year", String(year));
                if (month) args.push("--month", String(month));
                if (cap) args.push("--cap", String(cap));
                if (max_day) args.push("--max-day", String(max_day));
                if (end_time) args.push("--end-time", end_time);
                return run(args);
            },
        },
        {
            name: "ot_apply",
            description: "Áp dụng lịch OT tối ưu: tạo OT request qua API. Mặc định dry-run, thêm execute=true để tạo thật.",
            parameters: {
                type: "object",
                properties: {
                    year: { type: "number" },
                    month: { type: "number" },
                    cap: { type: "number" },
                    max_day: { type: "number" },
                    end_time: { type: "string" },
                    execute: { type: "boolean", description: "true = tạo thật, false = dry run (default: false)" },
                },
            },
            skipPermission: true,
            handler: async ({ year, month, cap, max_day, end_time, execute }) => {
                const args = ["apply"];
                if (year) args.push("--year", String(year));
                if (month) args.push("--month", String(month));
                if (cap) args.push("--cap", String(cap));
                if (max_day) args.push("--max-day", String(max_day));
                if (end_time) args.push("--end-time", end_time);
                if (execute) args.push("--execute");
                return run(args);
            },
        },
        {
            name: "ot_create_request",
            description: "Tạo OT request mới. Chỉ định ngày, giờ bắt đầu/kết thúc. API giới hạn tạo trong 7 ngày tới.",
            parameters: {
                type: "object",
                properties: {
                    date: { type: "string", description: "Ngày OT: YYYY-MM-DD" },
                    start: { type: "string", description: "Giờ bắt đầu HH:MM" },
                    end: { type: "string", description: "Giờ kết thúc HH:MM (nếu < start thì sang ngày hôm sau)" },
                    reason: { type: "string", description: "Lý do OT (default: task shishin)" },
                },
                required: ["date", "start", "end"],
            },
            skipPermission: true,
            handler: async ({ date, start, end, reason }) => {
                const args = ["create", "--date", date, "--start", start, "--end", end];
                if (reason) args.push("--reason", reason);
                return run(args);
            },
        },
        {
            name: "ot_edit_request",
            description: "Sửa OT request theo ID. Cập nhật giờ bắt đầu/kết thúc.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "number", description: "OT request ID" },
                    start: { type: "string", description: "Giờ bắt đầu mới HH:MM" },
                    end: { type: "string", description: "Giờ kết thúc mới HH:MM" },
                    reason: { type: "string" },
                },
                required: ["id", "start", "end"],
            },
            skipPermission: true,
            handler: async ({ id, start, end, reason }) => {
                const args = ["edit", "--id", String(id), "--start", start, "--end", end];
                if (reason) args.push("--reason", reason);
                return run(args);
            },
        },
        {
            name: "ot_delete_request",
            description: "Xóa OT request theo ID.",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "number", description: "OT request ID cần xóa" },
                },
                required: ["id"],
            },
            skipPermission: true,
            handler: async ({ id }) => run(["delete", "--id", String(id)]),
        },
    ],
    hooks: {
        onSessionStart: async () => {
            await session.log("OT Salary Optimizer extension loaded (8 tools)");
        },
    },
});

session.on("session.error", (event) => {
    session.log(`OT Optimizer error: ${event.data?.message}`, { level: "error" });
});
