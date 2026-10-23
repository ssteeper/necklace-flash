// The necklace flasher: writes a firmware package from the phone to the pendant over USB.
//
// The package is the zip that the necklace's CI makes (make_package.py in the private repo): bootloader.bin,
// partitions.bin and app.bin with manifest.json (each image's offset, size and SHA-256, and the partition table).
// CI uploads it to Google Drive, and Android's file picker opens Drive directly; the necklace-firmware artifact of
// any CI run is the same files. A bare app image (app.bin / necklace.ino.bin) also works: only the app is written.
//
// Chrome talks to the pendant's USB serial port through WebUSB with Google's web-serial-polyfill (Android, where
// Chrome has WebUSB but Web Serial has not covered wired ports), or through Web Serial where the browser has it
// (desktop). esptool-js does the ROM bootloader protocol either way. The pendant's port is the ESP32-C6's USB
// Serial/JTAG controller, which stays on the bus while the chip resets into the bootloader, so no buttons are needed.
//
// Written: the bootloader (0x0), the partition table (0x8000) and the app (0x10000), with no erase, so the saved
// settings (nvs) and the worlds pack are kept. Before writing it checks the package against its manifest, the chip,
// the flash size and the partition table on the pendant; every write is verified by MD5.

import { ESPLoader, Transport, serial as usbSerial, SparkMD5, unzipSync } from "./vendor.js";

const ESPRESSIF_VID = 0x303a;
const BAUD = 921600;            // the USB Serial/JTAG ignores it; equal ROM and stub rates skip a port reopen
const APP_OFFSET = 0x10000;

const $ = (id) => document.getElementById(id);
const ui = {
  pkg: $("pkg"), status: $("status"), go: $("go"), bar: $("bar"), barFill: $("bar-fill"), log: $("log"),
  link: $("link"), file: $("file"), support: $("support"),
};

let pkg = null;                  // {manifest, parts: [{name, offset, data}], label} of the chosen file
let busy = false;

function log(line) {
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}
function status(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = "status " + kind;
}
function progress(frac) {
  ui.bar.hidden = frac === null;
  if (frac !== null) ui.barFill.style.width = (100 * frac).toFixed(1) + "%";
}
const hex = (n) => "0x" + n.toString(16);
const kb = (n) => (n / 1024).toFixed(0) + " KB";

async function sha256(data) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// the ESP-IDF partition table: 32-byte entries (magic AA 50) up to the MD5 entry or erased flash
function parsePartitions(blob) {
  const out = [], v = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i + 32 <= blob.length; i += 32) {
    if (blob[i] !== 0xaa || blob[i + 1] !== 0x50) break;
    let label = "";
    for (let k = 12; k < 28 && blob[i + k]; k++) label += String.fromCharCode(blob[i + k]);
    out.push({ label, type: blob[i + 2] === 0 ? "app" : blob[i + 2] === 1 ? "data" : blob[i + 2],
               subtype: blob[i + 3], offset: v.getUint32(i + 4, true), size: v.getUint32(i + 8, true) });
  }
  return out;
}
const tableText = (t) => t.map((p) => `${p.label} ${hex(p.offset)} +${hex(p.size)}`).join(", ");
const sameTable = (a, b) => a.length === b.length && a.every((p, i) =>
  p.label === b[i].label && p.type === b[i].type && p.subtype === b[i].subtype && p.offset === b[i].offset &&
  p.size === b[i].size);

// ------------------------------------------------------------------ the firmware package
async function readPackage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {                 // "PK": a zip
    const files = unzipSync(bytes);
    const key = Object.keys(files).find((k) => k === "manifest.json" || k.endsWith("/manifest.json"));
    if (!key) throw new Error("this zip has no manifest.json: is it a necklace firmware package?");
    const dir = key.slice(0, key.length - "manifest.json".length);
    const manifest = JSON.parse(new TextDecoder().decode(files[key]));
    if (manifest.chip !== "ESP32-C6") throw new Error(`this package is for an ${manifest.chip}, not the pendant`);
    const parts = [];
    for (const p of manifest.parts) {
      const data = files[dir + p.file.split("/").pop()];
      if (!data) throw new Error(`${p.file} is missing from the zip`);
      if (data.length !== p.size || (await sha256(data)) !== p.sha256)
        throw new Error(`${p.file} does not match the manifest: the zip is damaged`);
      parts.push({ name: p.name, offset: p.offset, data });
    }
    const app = parts.find((p) => p.name === "app");
    if (!app || app.offset !== APP_OFFSET || app.data[0] !== 0xe9) throw new Error("the package has no app at 0x10000");
    return { manifest, parts, label: file.name };
  }
  if (bytes[0] === 0xe9) return { manifest: null, parts: [{ name: "app", offset: APP_OFFSET, data: bytes }], label: file.name };
  throw new Error(`${file.name} is neither a firmware package (.zip) nor an app image (.bin)`);
}

function describePackage() {
  ui.pkg.innerHTML = "";
  if (!pkg) { ui.pkg.hidden = true; return; }
  const m = pkg.manifest, app = pkg.parts.find((p) => p.name === "app");
  const rows = [["File", pkg.label]];
  if (m) {
    const date = new Date(m.date);
    rows.push(["Build", m.commit ? m.commit.slice(0, 7) : "local build"],
              ["Built", isNaN(date) ? m.date : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })],
              ["Writes", "bootloader, partition table, app"]);
  } else {
    rows.push(["Writes", "the app only"]);
  }
  rows.push(["App", kb(app.data.length)]);
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = k; dd.textContent = v;
    ui.pkg.append(dt, dd);
  }
  ui.pkg.hidden = false;
}

// ------------------------------------------------------------------ the connection
function connectionKind() {
  const want = ui.link.value;
  if (want === "serial") return "serial" in navigator ? "serial" : null;
  if (want === "usb") return "usb" in navigator ? "usb" : null;
  // automatic: WebUSB on Android (wired Web Serial is not reliably there), Web Serial elsewhere
  const android = /Android/i.test(navigator.userAgent);
  if (android && "usb" in navigator) return "usb";
  if ("serial" in navigator) return "serial";
  if ("usb" in navigator) return "usb";
  return null;
}

function updateUi() {
  const kind = connectionKind();
  ui.support.textContent = kind === "serial" ? "Connecting through Web Serial."
    : kind === "usb" ? "Connecting through WebUSB."
    : "This browser can't reach USB devices. Use Chrome on Android (or Chrome / Edge on a computer).";
  ui.support.className = kind ? "hint" : "hint bad";
  ui.go.disabled = busy || !kind || !pkg;
}

async function requestPort(kind) {
  // called first in the click handler: the browser's device chooser needs the tap's user activation
  if (kind === "serial") return navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
  return usbSerial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
}

// ------------------------------------------------------------------ flashing
async function flash() {
  const kind = connectionKind();
  let port;
  try {
    port = await requestPort(kind);
  } catch (e) {
    status(e.name === "NotFoundError" ? "No pendant chosen." : "Couldn't open the device chooser: " + e.message, "bad");
    return;
  }
  busy = true;
  updateUi();
  ui.log.textContent = "";
  progress(null);
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: log, write: (s) => log(s.replace(/\n$/, "")) };
  try {
    status("Connecting to the pendant's bootloader…");
    const loader = new ESPLoader({ transport, baudrate: BAUD, romBaudrate: BAUD, terminal });
    await loader.main("default_reset");
    const chip = loader.chip.CHIP_NAME;
    if (chip !== "ESP32-C6") throw new Error(`this is an ${chip}, not the pendant's ESP32-C6`);
    const size = await loader.detectFlashSize();
    if (size !== "16MB") throw new Error(`the flash is ${size}, not the pendant's 16 MB`);

    const current = parsePartitions(await loader.readFlash(0x8000, 0xc00));
    log("Partition table on the pendant: " + (current.length ? tableText(current) : "none"));
    const toWrite = pkg.parts;
    const newTable = toWrite.find((p) => p.name === "partitions");
    if (newTable) {
      const next = parsePartitions(newTable.data);
      if (!sameTable(current, next) &&
          !confirm("This package's partition table differs from the pendant's, so the worlds pack or saved " +
                   "settings may need flashing again afterwards.\n\nPendant: " + tableText(current) +
                   "\nPackage: " + tableText(next) + "\n\nFlash anyway?"))
        throw new Error("stopped: the partition tables differ");
    } else {
      const app = current.find((p) => p.type === "app" && p.offset === APP_OFFSET);
      if (!app) throw new Error("the pendant's partition table has no app at 0x10000");
      if (toWrite[0].data.length > app.size) throw new Error("the app image is larger than the pendant's app partition");
    }

    status("Writing…");
    const total = toWrite.reduce((s, p) => s + p.data.length, 0);
    const before = toWrite.map((_, i) => toWrite.slice(0, i).reduce((s, p) => s + p.data.length, 0));
    progress(0);
    await loader.writeFlash({
      fileArray: toWrite.map((p) => ({ data: p.data, address: p.offset })),
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false, compress: true,
      reportProgress: (i, written, n) => progress((before[i] + toWrite[i].data.length * written / n) / total),
      calculateMD5Hash: (img) => SparkMD5.ArrayBuffer.hash(new Uint8Array(img).buffer),
    });
    progress(1);
    log("Written and verified: " + toWrite.map((p) => `${p.name} ${kb(p.data.length)} at ${hex(p.offset)}`).join(", "));
    await loader.after("hard_reset");
    status("Done. The pendant restarts and is ready in about 4 s.", "good");
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log("Error: " + msg);
    status("Flashing failed: " + msg + ". Nothing is lost: the pendant can be flashed again.", "bad");
  } finally {
    try { await transport.disconnect(); } catch (_) { /* already closed */ }
    busy = false;
    updateUi();
  }
}

// ------------------------------------------------------------------ start
ui.go.addEventListener("click", () => { if (!busy && pkg) flash(); });
ui.link.addEventListener("change", updateUi);
ui.file.addEventListener("change", async () => {
  pkg = null;
  describePackage();
  updateUi();
  const f = ui.file.files[0];
  if (!f) { status("Choose a firmware package."); return; }
  status("Checking " + f.name + "…");
  try {
    pkg = await readPackage(f);
    status("Ready. Plug the pendant into the phone, then tap Flash.");
  } catch (e) {
    status(e.message, "bad");
  }
  describePackage();
  updateUi();
});
updateUi();
status("Choose a firmware package: necklace-latest.zip in Google Drive's “Necklace firmware” folder.");
