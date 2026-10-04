# StockSync — product facts and release notes

> Fictional; used only by the eval suite.

## What StockSync does today

- Connects Shopee, Lazada, TikTok Shop and WooCommerce websites.
- Keeps stock levels identical across connected channels; a sale on one
  channel lowers the stock on all the others within about one minute.
- Low-stock alerts: set a minimum per product, get an email and an in-app
  notification when stock falls to it.
- Import and export products and stock levels with CSV files (up to 5,000 rows
  per file).
- Works with Vietnamese and English product names.

## Not supported today

- Amazon, eBay and Etsy are not supported.
- StockSync does not issue invoices or handle payments.

## Release notes — version 2.4 (published)

- New: **Bulk stock edit.** Select many products and change their stock in one
  step. Changes are pushed to every connected channel.
- New: **Low-stock alerts per warehouse** (before, alerts were per product only).
- Improved: the CSV export now includes the channel name for each product.
- Fixed: stock sometimes showed twice for products with variants on Lazada.

## Release notes — before 2.4

- 2.3: TikTok Shop connection.
- 2.2: low-stock alerts by email.

## How-to tips

- Tip: set the minimum stock a little above what you can restock in a week, so
  the alert arrives before you sell out.
- Tip: connect a new channel when it is quiet; the first sync takes a few
  minutes per thousand products.
