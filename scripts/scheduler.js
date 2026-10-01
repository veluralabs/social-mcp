// Installs or removes a macOS background job (launchd) that sends due posts every minute,
// so scheduled posts go out even when no agent is open.
// Usage: npm run scheduler:install | npm run scheduler:uninstall
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LABEL = "com.veluralabs.social-mcp";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const log = path.join(root, ".data", "scheduler.log");

if (process.platform !== "darwin") {
  console.error(`This installer is for macOS. On Linux or Windows, run this every minute with cron or Task Scheduler:\n  ${process.execPath} ${path.join(root, "scripts", "run-due.js")}`);
  process.exit(1);
}

const launchctl = (...args) => {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {}
};

launchctl("unload", plist);
if (process.argv[2] === "uninstall") {
  fs.rmSync(plist, { force: true });
  console.log("Background job removed.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(log), { recursive: true });
fs.mkdirSync(path.dirname(plist), { recursive: true });
fs.writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${path.join(root, "scripts", "run-due.js")}</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
);
execFileSync("launchctl", ["load", plist], { stdio: "inherit" });
console.log(`Background job installed. It checks the queue every minute while you are logged in.\nLog: ${log}`);
