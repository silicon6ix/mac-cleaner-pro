// Read-only self-test: `npm run check`. Runs each scan for real and checks the safety rules.
// It never runs a clean action.
import assert from "node:assert/strict";
import { HOME } from "./util.js";
import { insideAllowedRoot, startScan, publicScan } from "./disk.js";
import { ramReport } from "./ram.js";
import { startupReport } from "./startup.js";

const X = `${HOME}/Library/Developer/Xcode`;
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

console.log("Safety fence");
check("allows a DerivedData project folder", () => assert.ok(insideAllowedRoot(`${X}/DerivedData/App-abc`)));
check("refuses the whole DerivedData folder", () => assert.ok(!insideAllowedRoot(`${X}/DerivedData`)));
check("refuses the whole Archives folder", () => assert.ok(!insideAllowedRoot(`${X}/Archives`)));
check("refuses Xcode settings (UserData/KeyBindings)", () => assert.ok(!insideAllowedRoot(`${X}/UserData/KeyBindings`)));
check("allows SwiftUI previews", () => assert.ok(insideAllowedRoot(`${X}/UserData/Previews`)));
check("refuses Documents", () => assert.ok(!insideAllowedRoot(`${HOME}/Documents/x`)));
check("refuses the home folder", () => assert.ok(!insideAllowedRoot(HOME)));
check("refuses the Caches folder itself", () => assert.ok(!insideAllowedRoot(`${HOME}/Library/Caches`)));
check("refuses project source", () => assert.ok(!insideAllowedRoot(`${HOME}/RND-Projects/app/src`)));
check("refuses lookalike paths", () => assert.ok(!insideAllowedRoot(`${HOME}/Library/CachesEvil/x`)));

console.log("Memory scan");
const ram = await ramReport();
check("reads total memory", () => assert.ok(ram.overview.total > 0));
check("groups processes by app", () => assert.ok(ram.apps.length > 0 && ram.apps[0].footprint > 0));

console.log("Startup scan");
const st = await startupReport();
check("lists launch agent folders", () => assert.equal(st.groups.length, 3));
check("only your own agents get buttons", () => assert.ok(st.groups.every((g) => g.items.every((i) => i.canToggle === (g.scope === "user")))));
check("daemon commands use sudo", () => assert.ok(st.groups.find((g) => g.scope === "system").items.every((i) => i.adminCommands.every((c) => c.startsWith("sudo ")))));

console.log("Disk scan (takes up to a minute)");
startScan();
while (!publicScan().done) await new Promise((r) => setTimeout(r, 500));
const items = publicScan().categories.flatMap((c) => c.items);
check("finds something to measure", () => assert.ok(items.length > 0));
check("protected items are never pre-ticked", () => assert.ok(items.filter((i) => i.protected).every((i) => !i.checked)));
check("downloads are never pre-ticked", () => assert.ok(items.filter((i) => i.category === "downloads").every((i) => !i.checked)));
check("archives are never pre-ticked", () => assert.ok(items.filter((i) => i.group === "Archives").every((i) => !i.checked)));
check("in-use build folders are never pre-ticked", () => assert.ok(items.filter((i) => i.tags.includes("In use")).every((i) => !i.checked)));

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
