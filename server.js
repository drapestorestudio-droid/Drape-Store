'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const PORT = Number(process.env.PORT || 5000);
const CF_APP_ID = process.env.CF_APP_ID || process.env.CASHFREE_APP_ID;
const CF_SECRET_KEY = process.env.CF_SECRET_KEY || process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV_URL = process.env.CASHFREE_ENV_URL || 'https://api.cashfree.com/pg/orders';
const CASHFREE_RETURN_URL = process.env.CASHFREE_RETURN_URL || 'https://stupendous-gnome-e1eec2.netlify.app/success.html';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const missingEnv = [];
if (!CF_APP_ID) missingEnv.push('CF_APP_ID or CASHFREE_APP_ID');
if (!CF_SECRET_KEY) missingEnv.push('CF_SECRET_KEY or CASHFREE_SECRET_KEY');
if (!CASHFREE_ENV_URL) missingEnv.push('CASHFREE_ENV_URL');
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
    const body = req.body || {};
    const productPrice = Number(body.product_price || body.productPrice);
    const customerName = String(body.customer_name || body.customerName || '').trim();
    const customerEmail = String(body.customer_email || body.customerEmail || '').trim();
    const customerPhone = String(body.customer_phone || body.customerPhone || '').trim();
    const shippingAddress = String(body.shipping_address || body.shippingAddress || '').trim();
    const pincode = String(body.pincode || '').trim();
    const productId = String(body.product_id || body.productId || '').trim();
    const productName = String(body.product_name || body.productName || '').trim();
    const selectedSize = String(body.selected_size || body.selectedSize || 'M').trim() || 'M';
    const selectedColor = String(body.selected_color || body.selectedColor || 'N/A').trim() || 'N/A';

    if (!customerName || !customerEmail || !customerPhone || !shippingAddress || !pincode || !productId || !productName) {
      return res.status(400).json({
        success: false,
        message: 'Missing required checkout fields.',
      });
    }

    if (!Number.isFinite(productPrice) || productPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product_price value.',
      });
    }

    const { data: orderRow, error: insertError } = await supabaseAdmin
      .from('orders')
      .insert([{
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        pincode: pincode,
        shipping_address: shippingAddress,
        product_id: productId,
        product_name: productName,
        product_price: productPrice,
        selected_size: selectedSize,
        selected_color: selectedColor,
        cf_order_id: null,
        cf_payment_id: null,
        payment_status: 'pending',
      }])
      .select('id')
      .single();

    if (insertError || !orderRow || !orderRow.id) {
      return res.status(500).json({
        success: false,
        message: (insertError && insertError.message) || 'Unable to create pending order in Supabase.',
      });
    }

    const supabaseOrderId = String(orderRow.id);
    const cfOrderId = `drape_${supabaseOrderId}_${Date.now()}`;

    const payload = {
      order_id: cfOrderId,
      order_amount: productPrice.toFixed(2),
      order_currency: 'INR',
      customer_details: {
        customer_id: supabaseOrderId,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
      },
      order_meta: {
        return_url: CASHFREE_RETURN_URL,
      },
    };

    const response = await axios.post(CASHFREE_ENV_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CF_APP_ID,
        'x-client-secret': CF_SECRET_KEY,
        'x-api-version': '2023-08-01',
      },
      timeout: 15000,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      const error = new Error('Cashfree order creation failed.');
      error.response = { status: response.status, data: response.data };
      throw error;
    }

    const paymentSessionId = response.data && response.data.payment_session_id;
    if (!paymentSessionId) {
      return res.status(502).json({
        success: false,
        message: 'Cashfree response did not include a payment_session_id.',
      });
    }

    const { error: pendingUpdateError } = await supabaseAdmin
      .from('orders')
      .update({
        cf_order_id: cfOrderId,
        payment_status: 'pending',
      })
      .eq('id', supabaseOrderId);

    if (pendingUpdateError) {
      return res.status(500).json({
        success: false,
        message: 'Cashfree order was created, but the pending Supabase row could not be updated.',
      });
    }

    return res.status(200).json({
      payment_session_id: paymentSessionId,
      cf_order_id: cfOrderId,
      supabase_order_id: supabaseOrderId,
    });
  } catch (error) {
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

    const statusResponse = await axios.get(`${CASHFREE_ENV_URL}/${encodeURIComponent(orderId)}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CF_APP_ID,
        'x-client-secret': CF_SECRET_KEY,
        'x-api-version': '2023-08-01',
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
