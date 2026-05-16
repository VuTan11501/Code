// Extension: dokokin-azure-login
// Manage Azure AD tokens for DokoKin — login, refresh, status, revoke.

import { execFile } from "node:child_process";
import { joinSession } from "@github/copilot-sdk/extension";

const SCRIPT_DIR = "C:\\Users\\Admin\\Downloads\\FJP Tool\\FJP Tool\\scripts";
const SCRIPT = `${SCRIPT_DIR}\\azure_auth.py`;
const PYTHON = "C:\\Users\\Admin\\AppData\\Local\\Programs\\Python\\Python312\\python.exe";

function runPython(args, timeout = 30000) {
    return new Promise((resolve) => {
        execFile(PYTHON, [SCRIPT, ...args], { cwd: SCRIPT_DIR, timeout }, (err, stdout, stderr) => {
            if (err) resolve(`Error (exit ${err.code}): ${stderr || err.message}\n${stdout}`);
            else resolve(stdout || "(no output)");
        });
    });
}

const session = await joinSession({
    tools: [
        {
            name: "dokokin_auth_login",
            description: "Đăng nhập Azure AD cho DokoKin (mở browser). Dùng lần đầu hoặc khi token hết hạn.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await session.log("Mở browser để đăng nhập Azure AD...", { ephemeral: true });
                return runPython(["--login"], 150000);
            },
        },
        {
            name: "dokokin_auth_refresh",
            description: "Refresh Azure AD token (silent, không cần browser). Dùng khi access token hết hạn nhưng refresh token còn.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--refresh"]),
        },
        {
            name: "dokokin_auth_status",
            description: "Xem trạng thái Azure AD token: user, email, hết hạn lúc nào, employee info.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--status"]),
        },
        {
            name: "dokokin_auth_status_json",
            description: "Token status dạng JSON (cho scripting/parsing).",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--status-json"]),
        },
        {
            name: "dokokin_auth_token",
            description: "Lấy raw Azure AD access token (stdout). Tự refresh nếu hết hạn.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => runPython(["--token"]),
        },
        {
            name: "dokokin_auth_revoke",
            description: "Xóa toàn bộ cached Azure AD tokens. Cần login lại sau đó.",
            parameters: { type: "object", properties: {} },
            handler: async () => runPython(["--revoke"]),
        },
    ],
    hooks: {
        onSessionStart: async () => {
            await session.log("DokoKin Azure AD login extension loaded");
        },
    },
});
