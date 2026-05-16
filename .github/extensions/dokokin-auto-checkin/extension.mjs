// Extension: dokokin-auto-checkin
// Auto checkin/checkout DokoKin (FJP) via Azure AD.

import { execFile } from "node:child_process";
import { joinSession } from "@github/copilot-sdk/extension";

const SCRIPT_DIR = "C:\\Users\\Admin\\Downloads\\FJP Tool\\FJP Tool\\scripts";
const SCRIPT = `${SCRIPT_DIR}\\auto_checkin.py`;
const PYTHON = "C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

function runPython(args) {
    return new Promise((resolve) => {
        execFile(PYTHON, [SCRIPT, ...args], { cwd: SCRIPT_DIR, timeout: 60000 }, (err, stdout, stderr) => {
            if (err) resolve(`Error (exit ${err.code}): ${stderr || err.message}\n${stdout}`);
            else resolve(stdout || "(no output)");
        });
    });
}

const session = await joinSession({
    tools: [
        {
            name: "dokokin_checkin",
            description: "Checkin DokoKin ngay bây giờ (đánh công vào). Dùng Azure AD token đã cache.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--checkin"]),
        },
        {
            name: "dokokin_checkout",
            description: "Checkout DokoKin ngay bây giờ (đánh công ra).",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--checkout"]),
        },
        {
            name: "dokokin_status",
            description: "Xem trạng thái chấm công hôm nay (checkin/checkout times).",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--status"]),
        },
    ],
    hooks: {
        onSessionStart: async () => {
            await session.log("DokoKin auto-checkin extension loaded");
        },
    },
});

session.on("session.error", (event) => {
    session.log(`DokoKin extension error: ${event.data?.message}`, { level: "error" });
});
