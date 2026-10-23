# Necklace flasher

A web page that flashes the necklace pendant (ESP32-C6) over USB from Chrome on an Android phone:
**https://ssteeper.github.io/necklace-flash/**

The page holds no firmware. You choose a firmware package on the phone (the necklace's CI uploads each build to
Google Drive, and Android's file picker opens Drive directly), and it goes straight from the phone to the pendant.

- **Package:** the zip from the necklace's CI: `bootloader.bin`, `partitions.bin`, `app.bin` and `manifest.json`
  (offsets, sizes, SHA-256, the partition table). A bare app image (`app.bin`) also works and writes only the app.
- **Connection:** WebUSB through Google's [web-serial-polyfill](https://github.com/google/web-serial-polyfill) on
  Android, or Web Serial where the browser has it for wired ports; [esptool-js](https://github.com/espressif/esptool-js)
  speaks the ROM bootloader's protocol. The ESP32-C6's USB Serial/JTAG port resets the chip into its bootloader
  without buttons.
- **Safety:** checks the package against its checksums, the chip, the 16 MB flash and the pendant's partition
  table (and asks if it differs); writes with no erase, so saved settings and the worlds pack are kept; verifies
  every write by MD5.

The libraries are pinned in `package.json` / `package-lock.json` and bundled into `vendor.js` by
`.github/workflows/pages.yml`, which publishes the page on every push to `main`. To run it locally:
`npm ci && npm run build`, then serve this folder (`python -m http.server`) and open it on `localhost`.
