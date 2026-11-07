# LineGrade evidence (collected 7 Nov 2026; paraphrased, check sources before quoting)

## The problem is real and recent
- Visa eliminated Level 2 incentives; verified Level 3 data is now the only route to lower B2B interchange. PYMNTS: https://www.pymnts.com/news/b2b-payments/2026/its-level-3-or-bust-as-visas-interchange-shift-rewires-b2b-data/
- Jan 2026: Level 2 small-business rates +75 bps, Product 3 (CEDP) +65 bps. Americaneagle: https://www.americaneagle.com/insights/blog/post/the-2026-payment-change
- Non-compliant merchants could face ~40% higher fees. Digital Transactions: https://www.digitaltransactions.net/commentary-visas-new-commercial-enhanced-data-program-what-merchants-need-to-know/
- Widespread compliance failures since enforcement; some clients saw cost increases over $500,000 within weeks. Crowdfund Insider: https://www.crowdfundinsider.com/2026/03/264411-verisave-fee-navigator-optimized-payments-create-compliance-tool-for-visas-cedp/
- Some B2B companies "blind-sided" by fee increases from non-qualifying transactions. Bill360: https://blog.bill360.com/what-is-visas-cedp

## Why: placeholder / missing data (LineGrade's exact gap)
- Processors used placeholder data and generic descriptions; CEDP was introduced partly to stop this. Merchant Cost Consulting: https://merchantcostconsulting.com/lower-credit-card-processing-fees/lost-level-3-interchange-savings/
- Visa rejects static/placeholder values (e.g. "ITEM1" for every description) and still charges the 0.05% participation fee. Pagos: https://pagos.ai/learn/cost
- Merchants reclassified as non-verified after Visa's AI audits detected placeholder or auto-filled data. Crowdfund Insider (above)
- Most common reason small B2B merchants overpay: absent data, because simple gateways/invoicing tools only capture Level 1. Beancount: https://beancount.io/blog/2026/10/12/interchange-downgrades-level-3-data-b2b-processing-costs-guide
- Survey: interchange fees are the top challenge in accepting B2B card payments, followed by the overhead of managing and transmitting the extra data. PaymentsJournal: https://www.paymentsjournal.com/level-up-optimizing-the-benefits-of-a-commercial-card-program/
- Braintree (and Stripe) support Level 3 via API but need custom development to pass line items. EBizCharge: https://ebizcharge.com/?p=83178

## Competitors / adjacent (real world) - know these for Q&A
- Fluid Pay, Lifted Payments, Revolution Payments: processors that auto-append Level 2/3 (the "auto-fill" approach CEDP now penalises when generic).
- EBizCharge: ERP-integrated Level 3 (needs ERP line-item data).
- Verisave / Fee Navigator / Optimized Payments: AI CEDP compliance *assessment* tool (diagnoses, does not generate the data).
- LineGrade angle: generates real, product-specific line-item data from the seller's own catalog for sellers without ERP, on Braintree/PayPal.

## Caveats / conflicts
- Sources disagree whether standard small-business cards benefit (EBizCharge says no; NMI/Americaneagle describe small-business Product 3 tiers). Demo uses a corporate/purchasing card case.
- Visa paused new verifications (Mar 2026 reports); PayPal's release guide says verification restarted 2/24/26. Status in flux - say so.
- All savings in LineGrade are estimates.
