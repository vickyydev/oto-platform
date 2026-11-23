# Central Floresta gate integration checkpoint

**Paused at park closing on 23 November 2026, Bangkok time.** Resume with the Entrance reader heartbeat and a refused test scan. The physical Exit reader has already completed that test. Track gate control and status in SCRUM-68, on-site readiness in SCRUM-223, and the known controller/reader assignment limitation in SCRUM-705.

## Closing state

| Item | Last verified state |
| --- | --- |
| Exit | BingdieGateMac configured as Exit (出口), machine 6661. The on-site photo showed “Exit” and the test refusal. The Pi received a real scan from 192.168.88.212. The last setting demonstrated was the temporary test URL. The operator was asked to restore the original URL. Readback after restoration is outstanding. |
| Entrance | App configuration showed Entrance (入口), machine 6658. The operator reported the same original server address on both readers. No scan or heartbeat proven from 6658. Verify its current server and interfaces on site. |
| Gate motion | The handheld open/close remote operated the barrier. The Android remote is a separate input device. Remote operation does not establish POS control or trigger a verified passage in OTO. |
| Till 1 Pi | Park host `oto-till`, wireless 192.168.88.12. Normal box service was active after cleanup. Installed release resolved to `0.1.0-20261112-39363738c`. No gate integration deployment or station assignment was made during this visit. |
| Temporary test | Manual listener on 192.168.88.12:18790 stopped at 21:50 on request to pause. Verified the port had no listener, its temporary script directory was removed, and the normal box service was running. The original 22:08 automatic expiry was superseded by this shutdown. |
| Printer and counts | The local band-print bridge was running, but its configured USB target `/dev/usb/band` was absent during the check. No physical wristband was printed, no valid admission was issued, and no test passage was written to POS. |

## Reader settings, network and login

- Both apps originally displayed `http://192.168.88.9:8083/`. The previous setting is the rollback value for this visit. Restoring it removes the temporary test destination. Its login service was still unreachable during the visit.
- With the old address, the app showed “No route to host” and repeatedly counted down “Logging in again”. Opening the app on the other gate reproduced the loop. Both the park laptop and Till 1 timed out before establishing a TCP connection to port 8083. The Android browser waited on the same URL. These observations do not identify whether the host changed, the service stopped or traffic was filtered.
- Reyee listed .9 as a 5 GHz client of the OTO POS Wi-Fi with MAC `4A:49:47:9A:9E:37`. The DHCP entry had device name `*` and 392 minutes remaining when photographed. No physical host or running service was identified from that lease. No router setting was changed by the test.
- The cabinet labels reported were 192.168.88.211 and 192.168.88.212. The photographed Android board reported wireless .199 with MAC `28:F5:2B:2C:8E:D3` and Ethernet .212 with MAC `2E:32:35:36:33:34`. The router saw .212 wired on OTOGateway LAN1. Both .199 and .212 answered at times, including a check when both resolved to the Ethernet MAC. The laptop and Pi could not resolve/reach .211 in the final checks. Treat .199 and .212 as interfaces of one photographed board. Mark physical lanes from their app direction, machine number, and a correlated request. Earlier conversational references calling .212 Entrance were not verified. The confirmed scan on .212 showed Exit.
- Android 7.1.2 on a Rockchip board named rk3126c in the board utility and rk3128 CB in Android status. The panel reports 600 × 1024. “Connect to PC” was under Android USB settings. The remote stopped responding after the operator selected it. The operator regained input with a mouse, cleared the setting and regained Android access on both gates. A USB role change is a plausible explanation for the input problem. Login retries continued independently. USB PC mode is unnecessary for the HTTP reader test.
- One gate restarted when the operator reconnected a black cable. A boot-time opening was reported. Use the Android settings with the lane clear and keep the existing cabling in place. There is no dedicated gate-control iPad at this site according to the operator.

## Physical test evidence

The probe bound to the Pi LAN address and accepted the known test clients. A browser GET at the root returned “OTO gate connection test”. It acknowledged a POST to `/interaction/Api/heartbeat`. Every POST to `/interaction/Api/checkCard` returned the string code `0` and “Connection test - no admission”. It logged request categories and source addresses without bodies or wristband codes. It had no connection to sales, attendance, the gate opener or the occupancy database.

| Bangkok time | Source | Pi journal and on-site observation |
| --- | --- | --- |
| 21:38:30 | Laptop .11 | Browser, refused scan and heartbeat verified the listener. These are synthetic checks. |
| 21:40:24 | .212 | Android browser reached the Pi. Another GET used an unrecognised path. |
| 21:47:52 | .212 | Physical reader sent its first recorded heartbeat. |
| 21:48:04, 21:48:11, 21:48:20 | .212 | Three refused scan requests. The Exit screen showed the returned message inside a Java exception from the app's scan handler. Three requests do not establish three separate wristbands or passages. |
| 21:48:17, 21:48:47, 21:49:17, 21:49:47, 21:50:17 | .212 | Heartbeats continued, roughly every 30 seconds in this sample. |

The journal was read from `oto-gate-observe-1795444705` on Till 1. The test proves a real reader can use a new server on the park network without restoring the former login service. The observed reader requests used a network connection to the Wi-Fi-connected Pi. Their source address was the board's Ethernet address. Independent operation over the board's wireless interface alone remains unverified.

## How this relates to the POS

- In the vendor's HTTP design the reader initiates the scan and heartbeat calls. OTO replies to the scan with an admission decision. A heartbeat success only acknowledges connectivity. A refusal does not command the barrier to close. The supplied reader specification documents no unsolicited open/close command addressed to the Android IP.
- The box code supports a reader relay, Pi relay or serial controller as an opener. The actual relay wiring, local GE-X2/HX-X1 serial path, and any optional network-to-controller adapter are unverified here. The original controller protocol also carries sensor-confirmed passage and alarms. No genuine permit, physical opening on a scan, or return event has yet been tested.
- The current gate host refuses entry when its controller cannot report a completed passage. A scan, an approval and physical passage are distinct events. The live people count derives from the band-event journal. A gate-access adult's latest confirmed entry or exit determines inside/outside. Refusals, alarms and no-passage timeouts add nobody. Regular child counts depend on the adult(s) from their sale, so start with one adult and no children to isolate the counter.
- Reference source at inspection was `4304f7e4704e4d860e5d3045e2f68cb0e4deb76e`. See [device inventory §6](../../../architecture/DEVICE_INVENTORY.md), [reader HTTP handler](../../../../packages/box-agent/src/gate/reader-host.ts), [real gate host](../../../../packages/box-agent/src/gate/host.ts), [opener](../../../../packages/box-agent/src/gate/opener.ts) and [occupancy projection](../../../../apps/api/src/services/occupancy.ts). The local supplier file is `imports/_vendor-docs/Gate_Interface_Specification_EN (1).pdf`. The full station reader host defaults to port 8790. The temporary diagnostic used 18790.

## Resume at the next park visit

1. Read back both apps' server address, machine number and direction, plus the Android board's current Wi-Fi/Ethernet addresses. Record whether Exit was restored. Keep the original settings for rollback. The old diagnostic address is currently inactive. In the app, 保存 means Save and 返回 means Back.
2. Start a fresh, time-limited deny-only reader listener on the Pi, scoped to the confirmed reader and bench addresses. Verify browser, heartbeat and refusal responses from the laptop first. Point **Entrance 6658** at the test destination with the lane clear. Correlate a physical heartbeat and one harmless QR scan with its screen and source. Return it to the designated operating configuration after the check.
3. Inspect the real gate controller and available passage-feedback connection. Confirm the board model, reader/relay arrangement and how to receive the board's passage report. Check SCRUM-705 before assigning a controller and both reader roles. Bring up the normal staging gate station with its actual box, opener and feedback link, and verify the health/readiness indications.
4. Connect and verify the band printer on Till 1. Check the queue for existing park work before reconnecting or replaying jobs. Issue and print an isolated staging adult gate-access band for Central Floresta under the normal sale flow. Record the branch count and the band history before testing. Keep the band QR private.
5. With staff supervising a clear lane, scan and pass through Entrance. Verify exactly one entry in the band history and an increase of one in the POS count. Pass through Exit with the same band and verify one exit and a return to the baseline. Verify that a denial, a duplicate entry and an allowed scan without passage do not add a person. Record physical movement, journal and count for each. Check related POS displays against the same branch and trading day.
6. Record installed box release, final device settings, evidence and test-data disposition on SCRUM-68. The successful refusal recorded above is a checkpoint only. Hardware acceptance, normal gate operation, band printing and occupancy acceptance remain open.
