# LineGrade design brief (hybrid)

References (studied from screen recordings, 7 Nov): evolt.dev (structure), matveyan.com (dark drama), akua.la (one accent + AI visual).
Avoid lookalikes: no notched buttons, no pixel-noise bands, no '/SECTION' labels, no custom spaced-caps wordmark (all evolt.dev signatures).
Rule: copy the *systems* (grid, type, spacing, motion), never logos, illustrations or copy.

## Concept
"Invoice-grade" = precise, engineered, auditable. Light technical workspace where the work happens; dark, cinematic moments where the value is revealed.
- DARK: landing and waking screen only (Matveyan-led: hero, preloader, waking-up).
- LIGHT: all app screens (Evolt-led): Enrich, Review, Order + pay, Readiness. One dark navy panel is allowed on a light page, for the readiness score reveal. Film grain is for dark surfaces only. (Changed 12 Nov: Enrich and Readiness were dark; the whole app now stays light after the landing page.)
- AKUA: one indigo accent + an iridescent orb used ONLY as the "AI is working" visual; dark navy metric panels.

## Tokens
Light:  --bg #F2F2EF  --surface #FFFFFF  --line #D9D9D4  --line-strong #BDBDB6  --text #111111  --muted #6B6B66
Dark:   --bg #0B0B0C (add 3-4% film grain overlay)  --surface #141416  --line #26262A  --text #EDEDE8  --muted #8A8A85
Accent (Akua indigo): --accent #4B3FE0  --accent-soft #E6E3FF
Status: --ok #1E8A5A  --review #C98A00  --fail #C2382F  --estimate #4B3FE0 (always dashed border + "ESTIMATE" tag)
Radius: 2px on controls (sharp); cards 4px. No pill buttons.

## Type (both free, OFL)
- Geist (UI, headings). Headings UPPERCASE, tight tracking (-0.01em), weights 500/600.
- Geist Mono for: section labels, codes (42132203), SKUs, amounts, confidence, transaction IDs. Tabular numbers everywhere.
- Section labels ("line-item stub", chosen 7 Nov): a 14x10 SVG of two stacked accent bars (top 14px long, bottom 8px long, each 2px tall, 4px gap), 10px gap, then the label in Geist Mono 12px uppercase, letter-spacing 0.08em, muted colour. Examples: CATALOG, AS VISA SEES IT, READINESS, ESTIMATED FEE.
  <svg width="14" height="10" viewBox="0 0 14 10"><rect x="0" y="1" width="14" height="2" fill="var(--accent)"/><rect x="0" y="7" width="8" height="2" fill="var(--accent)"/></svg>
  Dark mode accent #7F77DD. No numbers, no slashes, no square bullets. The tick is reserved for done/pass moments and the logo.
- Scale: 12 / 14 / 16 / 20 / 28 / 44 / 72 (hero, dark only).

## Layout (Evolt)
- Centered content column (max 1200px) framed by visible 1px vertical rails on both sides; full-width 1px horizontal rules between sections; small cross/corner markers where rails meet.
- Sections separated by a LINE-ITEM BAND: 3-4 rows of thin 1px horizontal lines of varying lengths (like printed invoice lines), muted colour, generated in SVG. (Replaces the pixel-noise band: too close to evolt.dev.)
- Stats in bordered cells sharing borders (like Evolt's 6 | 37 | 3 | 35 row).

## Components
- Primary button: black (light) / off-white (dark), sharp 2px radius, NO notch. Mono uppercase label followed by a small arrow (→); the tick appears only on completion buttons (Approve, Pay succeeded). (Notched corners were evolt.dev's signature.)
- Secondary: 1px outline. Dark-mode buttons get Matveyan dotted corner brackets.
- Status chips: mono uppercase, 1px border in status colour, tinted bg: OK / NEEDS REVIEW / FAILED / ESTIMATE / SYNTHETIC.
- HUD corners (Matveyan) on the landing page and app screens: tiny mono text in screen corners, e.g. "SANDBOX · BRAINTREE", "MODEL HAIKU 5.5", "CATALOG 40 SKUs".
- Labels that must ALWAYS be visible: "SYNTHETIC DATA" (persistent top-bar chip), "ESTIMATE" on any fee/saving figure, "SANDBOX" near any payment.

## AG Grid (Theming API, themeQuartz.withParams)
fontFamily Geist; headerFontFamily Geist Mono; headerTextColor muted; headerFontSize 11 (uppercase via CSS);
rowHeight 44; headerHeight 36; borderColor --line; rowBorder true; columnBorder true (grid-paper feel);
backgroundColor --surface; oddRowBackgroundColor transparent; selectedRowBackgroundColor --accent-soft;
accentColor --accent; wrapperBorderRadius 2; spacing 6.
Cells: code/SKU/UoM/amount columns in Geist Mono; confidence as a thin bar + number; status as chip;
"reason" in a side panel (not a column). Default filter: NEEDS REVIEW rows first.

## Motion (subtle, demo-friendly)
- Preloader (dark): logo mark + thin progress line (Matveyan), <1.2s.
- Enrichment: Akua-style iridescent orb pulses while rows stream into a ticking counter (36 / 40 classified).
- Row approve: chip flips NEEDS REVIEW -> OK, 150ms, row border flashes accent.
- Score reveal (in the navy panel): number counts up, stat cells draw their borders in.
- Payment: line items "print" into the Visa data panel one by one, then a green PASS stamp.
- No scroll-jacking. Respect prefers-reduced-motion.

## Screens
1. Landing (dark): HUD corners, headline "INVOICE-GRADE CARD DATA FOR B2B SELLERS", sub-line about Visa CEDP, CTA "LOAD DEMO CATALOG". Optional isometric diagram (original, our own): CATALOG -> AI -> VISA LEVEL 3 -> BRAINTREE / PAYPAL.
2. Enrich (light): orb + live counter + streaming list of SKUs with codes appearing.
3. Review (light): AG Grid opening on NEEDS REVIEW rows; side panel shows official UNSPSC title, runner-up code, reason, confidence; Approve / Edit locks row.
4. Order + pay (light): order builder (SKUs+qty), "AS VISA SEES IT" panel showing Level 3 line items exactly as sent, pay with Braintree sandbox, read-back + PASS checks, transaction id.
5. Readiness (light, with one dark navy panel for the score reveal): score, stat cells (rows OK, reviewed, Level 3 orders), "ESTIMATED fee: standard vs CEDP Product 3" with source + date, dashed estimate styling.

Footer (follows the screen theme: dark on the landing page, light on app screens): giant LINEGRADE wordmark (Matveyan), mono links, "Synthetic data · Sandbox · Estimates" line.

## Logo (option A, "checked line items") - chosen 7 Nov
Mark: three horizontal bars, decreasing length (invoice lines), with an accent tick finishing the shortest line.
Wordmark: "linegrade", lowercase, Geist 500, letter-spacing -0.02em. Never uppercase, never letter-spaced.
Light version (dark mode: bars #EDEDE8, tick #7F77DD):
<svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg">
  <rect x="3" y="6" width="22" height="3" fill="#111111"/>
  <rect x="3" y="15" width="16" height="3" fill="#111111"/>
  <rect x="3" y="24" width="10" height="3" fill="#111111"/>
  <path d="M19 25 l4 4 l8 -10" stroke="#4B3FE0" stroke-width="3" fill="none" stroke-linecap="square"/>
</svg>
Usage: mark + wordmark in top bar (mark 24px); mark alone as favicon; giant footer wordmark becomes lowercase "linegrade" with the tick mark.
Motion: on preloader and on PASS, the tick draws itself (stroke-dashoffset, 300ms).
Refine for pixel alignment at 16/24/32px; export web/public/logo.svg, logo-dark.svg, favicon.svg.
