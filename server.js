'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 5000);
// Use only the environment variables from the .env file.
const CASHFREE_APP_ID = String(process.env.CASHFREE_APP_ID || '').trim();
const CASHFREE_SECRET_KEY = String(process.env.CASHFREE_SECRET_KEY || '').trim();
const CASHFREE_ENV = String(process.env.CASHFREE_ENV || '').trim().toUpperCase();
const CASHFREE_ENV_NAME = CASHFREE_ENV === 'PRODUCTION' ? 'PRODUCTION' : 'PRODUCTION';
const CASHFREE_ENV_URL = 'https://api.cashfree.com/pg';
const CASHFREE_RETURN_URL = 'https://drapestore.co/success.html';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missingEnv = [];
if (!CASHFREE_APP_ID) missingEnv.push('CASHFREE_APP_ID');
if (!CASHFREE_SECRET_KEY) missingEnv.push('CASHFREE_SECRET_KEY');
if (!CASHFREE_ENV) missingEnv.push('CASHFREE_ENV');
if (!SUPABASE_URL) missingEnv.push('SUPABASE_URL');
if (!SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
if (missingEnv.length) {
  console.error('[Startup] Missing required environment variables:', missingEnv.join(', '));
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const app = express();

app.use(cors({ origin: true, credentials: false }));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Startup diagnostic: log which Cashfree endpoint is being used and whether credentials are present (no secrets logged)
console.log('[Startup] Cashfree mode:', CASHFREE_ENV_NAME);
console.log('[Startup] Cashfree endpoint:', CASHFREE_ENV_URL);
console.log('[Startup] CASHFREE app id present:', !!CASHFREE_APP_ID);
console.log('[Startup] CASHFREE secret key present:', !!CASHFREE_SECRET_KEY);

function formatErrorResponse(error) {
  if (error && error.response) {
    const data = error.response.data || {};
    const message = data.message || data.error || data.detail || 'Cashfree rejected the request.';
    return {
      status: error.response.status || 502,
      body: {
        success: false,
        message,
      },
    };
  }

  return {
    status: 500,
    body: {
      success: false,
      message: error && error.message ? error.message : 'Unexpected server error.',
    },
  };
}

function parseSupabaseOrderIdFromCashfreeOrderId(orderId) {
  const normalized = String(orderId || '').trim();
  if (!normalized) return null;

  const prefix = 'drape_';
  if (!normalized.startsWith(prefix)) {
    return null;
  }

  const remainder = normalized.slice(prefix.length);
  const lastSeparator = remainder.lastIndexOf('_');
  if (lastSeparator === -1) {
    return null;
  }

  return remainder.slice(0, lastSeparator).trim() || null;
}

function normalizeCashfreeStatus(payload) {
  const status = String(
    payload && (payload.order_status || payload.orderStatus || payload.status || payload.payment_status || '')
  ).trim().toUpperCase();

  return status;
}

app.get('/health', function (_req, res) {
  res.status(200).json({ ok: true });
});

app.post('/api/create-cashfree-order', async function (req, res) {
  console.log("=== RENDER LIVE BACKEND CHECK ===");
  console.log("App ID:", CASHFREE_APP_ID || "MISSING");
  console.log("Secret Key Present:", !!CASHFREE_SECRET_KEY);

  try {
    // 1. Destructure required fields from incoming payload
    const {
      customer_name,
      customer_email,
      customer_phone,
      customer_address,
      cart: incomingCart,
    } = req.body || {};

    const customerName = String(customer_name || '').trim();
    const customerEmail = String(customer_email || '').trim();
    const customerPhone = String((customer_phone || '').replace(/\D/g, '')).trim();
    const customerAddress = String(customer_address || '').replace(/[\r\n]+/g, ' ').trim();
    const cart = Array.isArray(incomingCart) ? incomingCart : [];

    // Validate presence of required fields. Fail fast to avoid blank rows.
    const missing = [];
    if (!customerName) missing.push('customer_name');
    if (!customerEmail) missing.push('customer_email');
    if (!customerPhone) missing.push('customer_phone');
    if (!customerAddress) missing.push('customer_address');
    if (!cart || cart.length === 0) missing.push('cart');

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: ' + missing.join(', '),
      });
    }

    // 2. Calculate total amount server-side (security best practice)
    let totalAmount = 0;
    for (const item of cart) {
      const price = Number(item.product && (item.product.price || item.price)) || 0;
      const quantity = Number(item.quantity) || 1;
      if (price <= 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid price for item: ${item.product && item.product.name}`,
        });
      }
      totalAmount += price * quantity;
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Cart total amount must be greater than zero.' });
    }

    // 2. SUPABASE LOGGING (insert full order BEFORE calling Cashfree)
    const { data: orderRow, error: insertError } = await supabaseAdmin
      .from('orders')
      .insert([{
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_email: customerEmail,
        customer_address: customerAddress,
        total_amount: totalAmount,
        cart: cart,
        cf_order_id: null,
        payment_status: 'PENDING',
      }])
      .select('id')
      .single();

    if (insertError || !orderRow || !orderRow.id) {
      return res.status(500).json({
        success: false,
        message: (insertError && insertError.message) || 'Unable to create order in Supabase.',
      });
    }

    const supabaseOrderId = String(orderRow.id);
    const cfOrderId = `drape_${supabaseOrderId}_${Date.now()}`;

    // Use trimmed request phone as customer_id and customer_phone (required by Cashfree)
    const phoneTrim = String(customer_phone || '').trim() || String(customerPhone || '').trim();
    const phoneForCashfree = phoneTrim;

    // Prepare Cashfree order payload exactly as required
    const payload = {
      order_amount: totalAmount,
      order_currency: 'INR',
      customer_details: {
        customer_id: phoneForCashfree,
        customer_phone: phoneForCashfree,
        customer_name: customerName,
        customer_email: customerEmail,
      },
      order_meta: {
        return_url: CASHFREE_RETURN_URL,
      },
    };

    console.log('Sending to Cashfree:', JSON.stringify(payload, null, 2));

    const cleanClientId = String(process.env.CASHFREE_APP_ID || '').trim();
    const cleanClientSecret = String(process.env.CASHFREE_SECRET_KEY || '').trim();

    // Ensure the SDK (if present) uses the requested Cashfree environment.
    try {
      const Cashfree = require('cashfree-sdk');
      if (Cashfree && Cashfree.Environment) {
        const targetEnvironment = CASHFREE_ENV === 'PRODUCTION' ? Cashfree.Environment.PRODUCTION : Cashfree.Environment.PRODUCTION;
        Cashfree.XEnvironment = targetEnvironment;
        console.log('[Startup] Cashfree SDK detected and initialized to', CASHFREE_ENV_NAME, 'mode.');
      }
    } catch (err) {
      // SDK not present — continue using direct HTTP calls
    }

    const cashfreeUrl = String(CASHFREE_ENV_URL || '').replace(/\/$/, '') + '/orders';

    console.log('🔍 === CASHFREE DEBUG START ===');
    console.log('📦 URL/Environment being hit:', cashfreeUrl);
    console.log('🆔 Client/App ID Value:', cleanClientId || 'UNDEFINED');
    console.log('🔑 Secret Key Length:', cleanClientSecret.length);
    console.log('🔍 === CASHFREE DEBUG END ===');

    let response;
    try {
      response = await axios.post(cashfreeUrl, payload, {
        headers: {
          'x-client-id': cleanClientId,
          'x-client-secret': cleanClientSecret,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        timeout: 15000,
        validateStatus: () => true,
      });

      if (response.status < 200 || response.status >= 300) {
        const error = new Error('Cashfree order creation failed.');
        error.response = { status: response.status, data: response.data };
        throw error;
      }
    } catch (error) {
      try {
        console.error('=== CASHFREE ORDER CREATION ERROR ===', error && error.response ? error.response.data : error);
      } catch (logErr) {
        console.error('=== CASHFREE ORDER CREATION ERROR (logging failed) ===', error);
      }
      throw error;
    }

    // Cashfree may return a payment link, order token, or payment_session_id depending on API version
    const paymentLink = response.data && (response.data.payment_link || response.data.paymentUrl || response.data.paymentLink);
    const orderToken = response.data && (response.data.order_token || response.data.orderToken || response.data.data && response.data.data.order_token);
    const paymentSessionId = response.data && (response.data.payment_session_id || response.data.paymentSessionId);

    if (!paymentLink && !orderToken && !paymentSessionId) {
      return res.status(502).json({
        success: false,
        message: 'Cashfree response did not include a payment link, order token, or payment_session_id.',
        cashfree: response.data,
      });
    }

    // Update master order with Cashfree order ID
    const { error: updateError } = await supabaseAdmin
      .from('orders')
      .update({
        cf_order_id: cfOrderId,
      })
      .eq('id', supabaseOrderId);

    if (updateError) {
      return res.status(500).json({
        success: false,
        message: 'Order created but could not update with Cashfree order ID.',
      });
    }

    // Prepare order_items for bulk insert
    const orderItems = cart.map((item) => ({
      order_id: supabaseOrderId,
      product_id: String(item.product && item.product.id || ''),
      product_name: String(item.product && item.product.name || ''),
      product_price: Number(item.product && item.product.price) || 0,
      quantity: Number(item.quantity) || 1,
      size: String(item.size || ''),
      color: String(item.color || 'N/A'),
    }));

    // Insert individual order items
    const { error: itemsInsertError } = await supabaseAdmin
      .from('order_items')
      .insert(orderItems);

    if (itemsInsertError) {
      console.error('[Order Items Insert Error]', itemsInsertError);
      return res.status(500).json({
        success: false,
        message: 'Order created but could not save individual items.',
      });
    }

    // Return success response with payment details (include whichever Cashfree returned)
    const respBody = {
      success: true,
      cf_order_id: cfOrderId,
      supabase_order_id: supabaseOrderId,
      cashfree: response.data,
    };
    if (paymentLink) respBody.payment_link = paymentLink;
    if (orderToken) respBody.order_token = orderToken;
    if (paymentSessionId) respBody.payment_session_id = paymentSessionId;

    return res.status(200).json(respBody);
  } catch (error) {
    console.error("❌ CRITICAL CASHFREE API ERROR:", error.response ? error.response.data : error.message);
    const formatted = formatErrorResponse(error);
    return res.status(formatted.status).json(formatted.body);
  }
});

async function verifyCashfreePayment(req, res, rawOrderId) {
  try {
    const orderId = String(rawOrderId || '').trim();

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Missing order_id parameter.',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase admin credentials are not configured on the backend.',
      });
    }

    const cleanClientId = String(process.env.CASHFREE_APP_ID || '').trim();
    const cleanClientSecret = String(process.env.CASHFREE_SECRET_KEY || '').trim();
    const statusUrl = String(CASHFREE_ENV_URL || '').replace(/\/$/, '') + '/orders/' + encodeURIComponent(orderId);
    const statusResponse = await axios.get(statusUrl, {
      headers: {
        'x-client-id': cleanClientId,
        'x-client-secret': cleanClientSecret,
        'x-api-version': '2023-08-01',
        'Accept': 'application/json',
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (statusResponse.status < 200 || statusResponse.status >= 300) {
      const error = new Error('Unable to verify Cashfree payment status.');
      error.response = { status: statusResponse.status, data: statusResponse.data };
      throw error;
    }

    const cashfreeStatus = normalizeCashfreeStatus(statusResponse.data || {});
    const isPaid = ['PAID', 'SUCCESS', 'COMPLETED', 'SUCCESSFUL', 'APPROVED'].includes(cashfreeStatus);

    if (!isPaid) {
      return res.status(409).json({
        success: false,
        message: 'Payment is not complete yet.',
        order_id: orderId,
        cashfree_status: cashfreeStatus || 'UNKNOWN',
      });
    }

    const cfPaymentId = String(
      statusResponse.data && (
        statusResponse.data.cf_payment_id ||
        statusResponse.data.cfPaymentId ||
        statusResponse.data.payment_id ||
        statusResponse.data.paymentId ||
        ''
      )
    ).trim() || null;

    let orderRow = null;
    let supabaseOrderId = null;

    const cfLookup = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('cf_order_id', orderId)
      .limit(1);

    if (!cfLookup.error && cfLookup.data && cfLookup.data.length) {
      orderRow = cfLookup.data[0];
      supabaseOrderId = orderRow.id;
    }

    if (!orderRow) {
      supabaseOrderId = parseSupabaseOrderIdFromCashfreeOrderId(orderId) || orderId;
      const idLookup = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('id', supabaseOrderId)
        .limit(1);

      if (idLookup.error || !idLookup.data || !idLookup.data.length) {
        return res.status(404).json({
          success: false,
          message: 'Order row not found in Supabase.',
          order_id: orderId,
        });
      }

      orderRow = idLookup.data[0];
    }

    const { data: updatedOrder, error: updateError } = await supabaseAdmin
      .from('orders')
      .update({
        cf_order_id: orderRow.cf_order_id || orderId,
        cf_payment_id: cfPaymentId,
        payment_status: 'paid',
      })
      .eq('id', supabaseOrderId)
      .select('*')
      .single();

    if (updateError || !updatedOrder) {
      return res.status(500).json({
        success: false,
        message: 'Payment verified, but the Supabase order could not be updated.',
        order_id: orderId,
        supabase_order_id: supabaseOrderId,
      });
    }

    return res.status(200).json({
      success: true,
      order_id: orderId,
      orderId: orderId,
      supabase_order_id: supabaseOrderId,
      supabaseOrderId: supabaseOrderId,
      cashfree_status: cashfreeStatus,
      cf_payment_id: cfPaymentId,
      order: updatedOrder,
      cashfree: statusResponse.data,
    });
  } catch (error) {
    const formatted = formatErrorResponse(error);
    return res.status(formatted.status).json(formatted.body);
  }
}

app.get('/api/verify-cashfree-payment', async function (req, res) {
  return verifyCashfreePayment(req, res, req.query.order_id || req.query.orderId);
});

app.post('/api/verify-cashfree-payment', async function (req, res) {
  return verifyCashfreePayment(req, res, req.body && (req.body.order_id || req.body.orderId || req.body.cfOrderId));
});

app.get('*', function (_req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, function () {
  console.log('DRAPE backend running on http://localhost:' + PORT);
});
