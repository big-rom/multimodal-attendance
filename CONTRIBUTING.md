# Contributing to Multimodal Attendance

We welcome contributions! Please read this guide to understand how the hardware and software communicate.

## Web Serial Configuration Protocol

The Web Dashboard uses the browser's Web Serial API to provision the ESP32 node securely over a physical USB connection. This prevents having to hardcode Wi-Fi credentials or backend URLs into the firmware.

### Protocol Details
- **Baud Rate**: 115200
- **Line Ending**: `\n` (Newline)
- **Format**: JSON strings.

### Commands Sent from Dashboard to ESP32

When the user configures the device, the dashboard sends single-line JSON commands to the ESP32 over serial. 

#### 1. Setup Wi-Fi & Backend
```json
{
  "cmd": "setup",
  "ssid": "MyWiFiNetwork",
  "pass": "MySecurePassword",
  "url": "https://my-project.supabase.co",
  "key": "eyJhbGci..."
}
```
*Effect:* The ESP32 saves these credentials to its Non-Volatile Storage (NVS) and immediately attempts to connect to the Wi-Fi.

#### 2. Clear Wi-Fi Credentials
```json
{
  "cmd": "clear_wifi"
}
```
*Effect:* Wipes the NVS partition containing the SSID and Password, forcing the ESP32 back into an unprovisioned state.

### Logs Sent from ESP32 to Dashboard

The ESP32 streams its logs back over the serial connection. The dashboard parses lines starting with `{` as JSON.

```json
{
  "type": "status",
  "mode": "idle",
  "ip": "192.168.1.5",
  "ssid": "MyWiFiNetwork",
  "version": "1.0.0"
}
```
*Effect:* The dashboard uses this to display the clean device status cards on the Device Setup page.

## Pull Requests

1. Please make sure the code conforms to the existing Prettier/ESLint configs.
2. Run `npm run lint` and `npx tsc` to verify your changes.
3. Keep hardware firmware changes and backend schema changes in separate PRs where possible to ease review.
