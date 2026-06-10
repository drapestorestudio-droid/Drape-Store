'use strict';

const nodemailer = require('nodemailer');

const EMAIL_FROM = process.env.EMAIL_FROM || 'DRAPE <no-reply@drape.store>';
const EMAIL_SUPPORT = process.env.EMAIL_SUPPORT || 'help@drape.store';
const SMTP_HOST = process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT || '465');
const SMTP_SECURE = process.env.EMAIL_SMTP_SECURE ? process.env.EMAIL_SMTP_SECURE === 'true' : SMTP_PORT === 465;
const SMTP_USER = process.env.EMAIL_SMTP_USER;
const SMTP_PASS = process.env.EMAIL_SMTP_PASS;

if (!SMTP_USER || !SMTP_PASS) {
  throw new Error('Missing email SMTP credentials. Set EMAIL_SMTP_USER and EMAIL_SMTP_PASS in your environment.');
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

function formatCurrency(value) {
  const amount = Number(value || 0);
  return amount > 0 ? '₹' + amount.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '₹0.00';
}

function safe(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function buildOrderConfirmationTemplate(order) {
  const orderId = safe(order.cf_order_id || order.id || 'N/A');
  const productName = safe(order.product_name || 'DRAPE product');
  const productPrice = formatCurrency(order.product_price || order.total_amount || 0);
  const productSize = safe(order.selected_size || 'M');
  const productColor = safe(order.selected_color || 'N/A');
  const customerName = safe(order.customer_name || order.customer_name || 'DRAPE Customer');

  return {
    subject: `Your DRAPE order is confirmed! ⚡ (Order ID: #${orderId})`,
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DRAPE Order Confirmation</title>
  <style>
    body { margin:0; padding:0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f5f1; color:#121212; }
    .wrapper { width:100%; max-width:680px; margin:0 auto; padding:32px; }
    .card { background:#fff; border-radius:24px; box-shadow:0 24px 68px rgba(4,4,4,0.08); overflow:hidden; }
    .header { padding:32px 32px 24px; background:#111; color:#fff; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.04em; }
    .header p { margin:16px 0 0; color:rgba(255,255,255,0.7); font-size:14px; line-height:1.7; }
    .section { padding:32px; }
    .section h2 { margin:0 0 18px; font-size:18px; letter-spacing:0.08em; text-transform:uppercase; color:#222; }
    .summary { border:1px solid rgba(18,18,18,0.08); border-radius:18px; overflow:hidden; }
    .summary-row { display:flex; justify-content:space-between; gap:16px; padding:18px 20px; }
    .summary-row:nth-child(even) { background:rgba(18,18,18,0.03); }
    .summary-row strong { color:#121212; }
    .button-wrap { margin-top:30px; text-align:center; }
    .button { display:inline-block; padding:14px 28px; background:#121212; color:#fff; text-decoration:none; border-radius:999px; font-weight:700; letter-spacing:0.06em; }
    .footer { padding:24px 32px 32px; font-size:13px; color:rgba(18,18,18,0.65); line-height:1.8; }
    .footer a { color:#121212; text-decoration:none; font-weight:600; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <h1>Order confirmed.</h1>
        <p>Thanks for choosing DRAPE. Your premium order is now secured and processing for dispatch.</p>
      </div>

      <div class="section">
        <h2>Order summary</h2>
        <div class="summary">
          <div class="summary-row"><span>Order ID</span><strong>#${orderId}</strong></div>
          <div class="summary-row"><span>Customer</span><strong>${customerName}</strong></div>
          <div class="summary-row"><span>Product</span><strong>${productName}</strong></div>
          <div class="summary-row"><span>Size</span><strong>${productSize}</strong></div>
          <div class="summary-row"><span>Color</span><strong>${productColor}</strong></div>
          <div class="summary-row"><span>Total paid</span><strong>${productPrice}</strong></div>
        </div>
      </div>

      <div class="section" style="padding-top:0;">
        <p>We are preparing your DRAPE piece for the next step: premium packaging and shipment. Expect a shipping confirmation email soon.</p>
        <div class="button-wrap">
          <a class="button" href="https://drape.store" target="_blank">Visit DRAPE</a>
        </div>
      </div>
    </div>

    <div class="footer">
      <p>If you have questions, reply to this email or contact us at <a href="mailto:${EMAIL_SUPPORT}">${EMAIL_SUPPORT}</a>.</p>
    </div>
  </div>
</body>
</html>`,
    text: `Your DRAPE order is confirmed!\n\nOrder ID: #${orderId}\nCustomer: ${customerName}\nProduct: ${productName}\nSize: ${productSize}\nColor: ${productColor}\nTotal paid: ${productPrice}\n\nThanks for choosing DRAPE. We are preparing your order for premium packaging and shipment.\n\nIf you have questions, email ${EMAIL_SUPPORT}.`,
  };
}

function buildShippingConfirmationTemplate(order, trackingProvider, trackingNumber) {
  const orderId = safe(order.cf_order_id || order.id || 'N/A');
  const productName = safe(order.product_name || 'DRAPE product');
  const customerName = safe(order.customer_name || order.customer_name || 'DRAPE Customer');
  const productPrice = formatCurrency(order.product_price || order.total_amount || 0);
  const trackingUrl = safe(order.tracking_url || `https://www.${trackingProvider.toLowerCase().replace(/\s+/g, '')}.com/track/${trackingNumber}`);

  return {
    subject: 'Your DRAPE package is on the way! 📦',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DRAPE Shipping Confirmation</title>
  <style>
    body { margin:0; padding:0; font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f6f5f1; color:#121212; }
    .wrapper { width:100%; max-width:680px; margin:0 auto; padding:32px; }
    .card { background:#fff; border-radius:24px; box-shadow:0 24px 68px rgba(4,4,4,0.08); overflow:hidden; }
    .header { padding:32px 32px 24px; background:#111; color:#fff; }
    .header h1 { margin:0; font-size:28px; letter-spacing:0.04em; }
    .header p { margin:16px 0 0; color:rgba(255,255,255,0.75); font-size:14px; line-height:1.7; }
    .section { padding:32px; }
    .section h2 { margin:0 0 18px; font-size:18px; letter-spacing:0.08em; text-transform:uppercase; color:#222; }
    .summary { border:1px solid rgba(18,18,18,0.08); border-radius:18px; overflow:hidden; }
    .summary-row { display:flex; justify-content:space-between; gap:16px; padding:18px 20px; }
    .summary-row:nth-child(even) { background:rgba(18,18,18,0.03); }
    .cta { margin-top:30px; text-align:center; }
    .button { display:inline-block; padding:14px 28px; background:#121212; color:#fff; text-decoration:none; border-radius:999px; font-weight:700; letter-spacing:0.06em; }
    .footer { padding:24px 32px 32px; font-size:13px; color:rgba(18,18,18,0.65); line-height:1.8; }
    .footer a { color:#121212; text-decoration:none; font-weight:600; }
    .status-label { margin-top:18px; display:block; font-size:14px; color:#4b5563; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      <div class="header">
        <h1>Your DRAPE package is on the way!</h1>
        <p>Your order has shipped and is moving through premium delivery channels.</p>
      </div>

      <div class="section">
        <h2>Shipment details</h2>
        <div class="summary">
          <div class="summary-row"><span>Order ID</span><strong>#${orderId}</strong></div>
          <div class="summary-row"><span>Product</span><strong>${productName}</strong></div>
          <div class="summary-row"><span>Delivery partner</span><strong>${trackingProvider}</strong></div>
          <div class="summary-row"><span>Tracking number</span><strong>${trackingNumber}</strong></div>
          <div class="summary-row"><span>Paid amount</span><strong>${productPrice}</strong></div>
        </div>

        <div class="cta">
          <a class="button" href="${trackingUrl}" target="_blank">Track Your Package</a>
        </div>
        <span class="status-label">If the link does not work, use your tracking number directly with ${trackingProvider}.</span>
      </div>
    </div>

    <div class="footer">
      <p>Need help? Email <a href="mailto:${EMAIL_SUPPORT}">${EMAIL_SUPPORT}</a>, and we’ll respond within one business day.</p>
    </div>
  </div>
</body>
</html>`,
    text: `Your DRAPE package is on the way!\n\nOrder ID: #${orderId}\nProduct: ${productName}\nCarrier: ${trackingProvider}\nTracking number: ${trackingNumber}\n\nTrack your package: ${trackingUrl}\n\nIf you need help, email ${EMAIL_SUPPORT}.`,
  };
}

async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject || !html) {
    throw new Error('Missing required email fields: to, subject, and html are required.');
  }
  return transporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim(),
    html,
  });
}

async function sendOrderConfirmationEmail(order) {
  const customerEmail = safe(order.customer_email || order.email);
  if (!customerEmail) {
    throw new Error('Order confirmation email cannot be sent without customer_email.');
  }
  const { subject, html, text } = buildOrderConfirmationTemplate(order);
  return sendEmail({ to: customerEmail, subject, html, text });
}

async function sendShippingConfirmationEmail(order) {
  const customerEmail = safe(order.customer_email || order.email);
  if (!customerEmail) {
    throw new Error('Shipping confirmation email cannot be sent without customer_email.');
  }
  const trackingProvider = safe(order.tracking_provider || order.carrier || 'Drape Logistics');
  const trackingNumber = safe(order.tracking_number || order.tracking_id || 'DRP-000000000');
  const { subject, html, text } = buildShippingConfirmationTemplate(order, trackingProvider, trackingNumber);
  return sendEmail({ to: customerEmail, subject, html, text });
}

module.exports = {
  sendOrderConfirmationEmail,
  sendShippingConfirmationEmail,
};
