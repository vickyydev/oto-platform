# SCRUM-763 — The customer display opens on a language choice, on staging

**Result: passed.** At the start of a sale the customer's screen shows "Choose your language" and five cards: English, 中文, ไทย, Русский and Français. Each card is written in its own language. One tap sets the language for that customer, and the phone-number step follows in that language. The choice does not come back during the sale. It does come back for the next customer, after a sale is paid or cancelled. The small language button still changes the language on the later screens. A separately paired customer display also opens on the same choice.

There is one observation outside the six steps, about the paired display. It is in "What is not finished on staging" below.

- **Where:** the staging till app, https://oto-pos-web-staging.onrender.com, at Oto Play Park, Central Floresta.
- **Version:** commit 183ed206 was live on oto-pos-web-staging and oto-pos-staging before and after the run (read at 20:14 and 20:23 Bangkok time). The page's script carries the change. oto-api-staging stayed on ed6e092d, an earlier commit. Details are in `receipt.json` under `deploys` and `bundle`.
- **When:** 9 November 2026, 20:15–20:23 Bangkok time. No page errors were recorded.
- **How:** a headless Chromium with touch turned on, so every press on a customer screen is a real touch tap. The till was 1440 × 900 and the paired display was 1024 × 768. The till was signed in as the staging reception account (Som).
- **Till:** a test till made for this run, "ZZ TEST SCRUM-763 till" on Virtual box 1, receipt prefix Z763. It was archived at the end.
- **Customer screens:** steps 1–5 use the till's own customer half (the right half of the till in its test view). Step 6 uses a separate display page in its own browser. It was paired to the test till with that page's own pairing code, and the pairing was revoked at the end.

## What was done, and what each picture shows

**1. The first screen of a sale**
- `763-st-01a-start-of-sale-language-choice.png`: the customer half shows "Choose your language". Beneath it is the same question in the other four languages. Then come the language cards. There is no keypad and no small language button. The staff half on the left is waiting for the customer.
- `763-st-01b-language-choice-scrolled-five-cards.png`: the same screen scrolled to its end. It shows all five cards, each with "Continue in …" written in its own language. (At 900 px high the fifth card sits just below the edge.)

**2. The guest taps ไทย**
- `763-st-02a-thai-chosen-phone-step-in-thai.png`: the phone-number step is in Thai: "เบอร์โทรศัพท์ของคุณคืออะไร?". The safety line starts "เราขอเบอร์โทรศัพท์ทุกครั้งที่มา", and the small language button in the corner reads ไทย. The staff half stays in English.
- `763-st-02b-thai-phone-step-keypad-clear-key.png`: the same step scrolled down. It shows the keypad with its ล้าง (Clear) key and the Thai Continue button "ดำเนินการต่อ".
- The test number was typed on the customer's keypad and Continue was pressed. The number was unknown, so staff chose "Continue as walk-in".
- `763-st-02c-welcome-stays-in-thai.png`: the welcome screen is in Thai: "ยินดีต้อนรับสู่ Oto". The language button reads ไทย.
- `763-st-02d-order-screen-stays-in-thai.png`: Tourist, 1 Hour Play, 1 kid and 1 adult are in the cart. The customer's order screen is in Thai, with "คำสั่งซื้อของคุณ" beside the language button.
- The till page logged every time the choice appeared or disappeared. After the ไทย tap it did not appear again during this sale.

**3. The small language button still works**
- `763-st-03-language-button-switches-order-to-french.png`: the language button on the order screen was tapped and Français was picked from its menu. The order screen changes to French: "Votre commande", "Jeu 1 heure", "Enfants", "Adultes" and "TVA incluse". The choice screen did not reappear.

**4. Paid in cash, then the next customer**
- `763-st-04a-paid-cash-thank-you-in-french.png`: the sale was paid in cash for the full amount. The receipt is **Z763-000001**: ฿1,040, cash, paid. The customer half says "Merci !". Band codes and credit QR codes are hidden with magenta blocks.
- `763-st-04b-next-sale-choice-again-headed-in-french.png`: after "Start New Sale", the choice is back for the next guest. Its heading is in the last guest's language, "Choisissez votre langue", and the other four languages are beneath it. There is no keypad and no language button.

**5. Cancel on the till**

Cancel was pressed three times, in three different situations. Each time the next sale opened on the choice, and no sale was written. The till kept exactly one sale, Z763-000001.
- `763-st-05a-cancel-with-choice-on-screen-choice-stays.png`: Cancel was pressed while the choice was on screen. The choice stays, still headed in French.
- `763-st-05b-cancel-after-chinese-chosen-choice-returns.png`: a guest tapped 中文 and reached the phone step in Chinese ("您的电话号码是多少？", with the 清除 key). Staff then pressed Cancel, as if the guest had walked away. The choice is back, headed "请选择您的语言".
- `763-st-05c1-chinese-order-before-cancel.png` and `763-st-05c2-cancel-with-ticket-in-cart-choice-returns.png`: a second guest chose 中文 and typed a second test number. An unpaid order (1 Hour Play, 1 kid and 1 adult) showed in Chinese as "您的订单". Cancel emptied the order and the choice came back. The only thing the till sent for that cart was a price quote.

**6. A separately paired display**
- `763-st-06a-paired-display-first-screen-language-choice.png`: a display page was opened in its own browser and paired to the test till with that page's pairing code. Its first screen is the same choice. The till then said "Display connected: ZZ TEST SCRUM-763 display", and its own customer half closed. This picture was taken after one reload of the display page, made to read what the display receives. The screen read the same right after pairing, before the reload.
- `763-st-06b-paired-display-russian-phone-step.png`: after a tap on Русский, the display's phone step is in Russian: "Ваш номер телефона?". The safety line and the Continue button "Продолжить" are in Russian too, and the language button reads Русский.
- `763-st-06c-till-staff-half-english-display-connected.png`: the till at the same moment. Its staff half is in English and waits for the customer.
- The pairing was then revoked (see Clean-up).

## What is not finished on staging (observation, not one of the six steps)

- `763-st-06d-paired-display-after-till-cancel.png`: the paired display showed the Russian phone step with nothing typed. Staff pressed Cancel on the till. The display **stayed on the Russian phone step** and did not reopen the choice. The till's own customer half does reopen it in that situation (step 5b).
- **Why:** Virtual box 1, which serves the test till and its display, runs inside oto-api-staging. That service is still on ed6e092d. It does not have the box change 36f19edee, which keeps the sale's name on the first screen. The display's own reading confirms it. The first-screen message reaching the display carried only kind, phone, nickname, requestId and contactChannel, with no sale name. So the display uses the older rule: it asks again only after it has left the first screen and come back.
- This case should work once oto-api-staging is deployed at 183ed206 or later. The counter box (Pi) needs the next box release for the same change.
- **Not shown:** a full paid sale through the paired display, then the next guest. That needs another cash sale and was not part of this run's steps.

## Clean-up (20:23 Bangkok time, read back)

- The display pairing was revoked, and the till now lists no display. The display page then offered a new pairing code, and that code was expired with the page's "Expire code now" button.
- The till signed out, and its session was refused afterwards (401). Its printers were unassigned and the till was archived; a read-back shows it archived with no devices. The admin session signed out too.
- Neither test number is a member.
- Reception Till 1 keeps its seven devices. Till 1 (Pi), Till 2 (test) and FWBooth1 are unchanged.
- No till notice was pressed (the "7 overdue" and "4 out of stock" banners were left alone). No setting was read or changed, and no text message was sent.
- The sale Z763-000001 stays on record as paid, as in earlier proofs.

Every step's read-back is in `receipt.json`: the screen text, the cards, the language button, the keypad, the till's sales before and after each cancel, every request the pages sent, and the clean-up.
