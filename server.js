'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const supabaseAdmin = supabase;

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: false }));
app.options('*', cors());
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

app.post('/webhook/cashfree', async (req, res) => {
    const eventType = req.body.data?.event_type;
    const orderId = req.body.data?.order?.order_id;

    if (eventType === 'SUCCESS_PAYMENT') {
        const { error } = await supabase
            .from('orders')
            .update({ payment_status: 'success' })
            .eq('cf_order_id', orderId);

        if (error) {
            console.error('Supabase Update Error:', error);
            return res.status(500).send('Database Update Failed');
        }
        return res.status(200).send('Status Updated to Success');
    }

    return res.status(200).send('Event ignored');
});

app.post('/api/create-cashfree-order', async (req, res) => {
  try {
    let { customer_name, customer_email, customer_phone, grand_total, order_id } = req.body || {};

    // Assign safe defaults instead of failing when fields are missing.
    customer_name = customer_name != null ? String(customer_name) : '';
    customer_email = customer_email != null ? String(customer_email) : 'N/A';
    customer_phone = customer_phone != null ? String(customer_phone) : '0';
    grand_total = grand_total != null ? grand_total : 0;

    const cleanPhone = String(customer_phone).replace(/[^0-9]/g, '');
    const cleanCustomerId = String((customer_email || 'N/A')).toLowerCase().replace(/[^a-z0-9]/g, '_');

    // Safely parse amount; fall back to 0 when parsing fails.
    const parsedAmount = parseFloat(String(grand_total));
    const safeAmount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
    const cleanAmount = Number(safeAmount.toFixed(2));
    const safeOrderId = order_id || `order_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const requestData = {
      order_id: safeOrderId,
      order_amount: cleanAmount,
      order_currency: 'INR',
      customer_details: {
        customer_id: cleanCustomerId,
        customer_name: customer_name || 'Customer',
        customer_email: customer_email,
        customer_phone: cleanPhone,
      },
      order_meta: {
        return_url: 'https://drapestore.co/success.html',
      },
    };

    const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(requestData),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Cashfree Rejected Payload:', data);
      return res.status(response.status).json({ success: false, errorSource: 'Cashfree API', cashfreeRawError: data });
    }

    return res.status(200).json({ success: true, payment_session_id: data.payment_session_id });
  } catch (error) {
    console.error('Server Catch Error:', error);
    return res.status(500).json({ success: false, message: 'System catch error', error: error.message });
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
    const statusUrl = `${CASHFREE_BASE_URL}/orders/${encodeURIComponent(orderId)}`;
    const statusResponse = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        'x-client-id': cleanClientId,
        'x-client-secret': cleanClientSecret,
        'x-api-version': '2023-08-01',
        'Accept': 'application/json',
      },
    });

    const statusData = await statusResponse.json().catch(() => null);

    if (!statusResponse.ok) {
      const error = new Error('Unable to verify Cashfree payment status.');
      error.response = { status: statusResponse.status, data: statusData };
      throw error;
    }

    const cashfreeStatus = normalizeCashfreeStatus(statusData || {});
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
      statusData && (
        statusData.cf_payment_id ||
        statusData.cfPaymentId ||
        statusData.payment_id ||
        statusData.paymentId ||
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
