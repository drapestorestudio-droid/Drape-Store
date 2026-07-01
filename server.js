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
const CASHFREE_BASE_URL = CASHFREE_ENV === 'PRODUCTION' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
const CASHFREE_RETURN_URL = String(process.env.CASHFREE_RETURN_URL || '').trim();
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missingEnv = [];
if (!CASHFREE_APP_ID) missingEnv.push('CASHFREE_APP_ID');
if (!CASHFREE_SECRET_KEY) missingEnv.push('CASHFREE_SECRET_KEY');
if (!CASHFREE_ENV) missingEnv.push('CASHFREE_ENV');
if (!CASHFREE_RETURN_URL) missingEnv.push('CASHFREE_RETURN_URL');
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
console.log('[Startup] Cashfree mode:', CASHFREE_ENV);
console.log('[Startup] Cashfree endpoint:', CASHFREE_BASE_URL);
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
  try {
    const {
      customer_name,
      customer_email,
      customer_phone,
      grand_total,
      order_id,
    } = req.body || {};

    const customerName = String(customer_name || '').trim();
    const customerEmail = String(customer_email || '').trim();
    const customerPhone = String(customer_phone || '').replace(/\D/g, '').trim();
    const amount = Number(grand_total || 0);
    const orderId = String(order_id || '').trim();

    const missing = [];
    if (!customerName) missing.push('customer_name');
    if (!customerEmail) missing.push('customer_email');
    if (!customerPhone) missing.push('customer_phone');
    if (!Number.isFinite(amount) || amount <= 0) missing.push('grand_total');
    if (!orderId) missing.push('order_id');

    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: ' + missing.join(', '),
      });
    }

    const payload = {
      order_amount: Number(amount.toFixed(2)),
      order_currency: 'INR',
      customer_details: {
        customer_id: customerPhone || `cust_${Date.now()}`,
        customer_phone: customerPhone,
        customer_name: customerName,
        customer_email: customerEmail,
      },
      order_meta: {
        return_url: CASHFREE_RETURN_URL,
      },
      order_id: orderId,
    };

    const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = await response.text().catch(() => null);
    }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        cashfreeError: data,
      });
    }

    return res.status(200).json({
      success: true,
      cashfree: data,
    });
  } catch (error) {
    console.error('Cashfree order creation failed:', error);
    return res.status(500).json({
      success: false,
      message: error && error.message ? error.message : 'Unexpected server error.',
    });
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

    const cleanClientId = CASHFREE_APP_ID;
    const cleanClientSecret = CASHFREE_SECRET_KEY;
    const statusUrl = String(CASHFREE_BASE_URL || '').replace(/\/$/, '') + '/orders/' + encodeURIComponent(orderId);
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

app.use((err, req, res, next) => {
  console.error('🚨 GLOBAL SERVER ERROR CAUGHT:');
  console.error(err.stack || err);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, function () {
  console.log('DRAPE backend running on http://localhost:' + PORT);
});
