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
    const name = (req.body.name || req.body.customer_name || 'Guest Customer').trim();
    const phone = (req.body.phone || req.body.customer_phone || '').replace(/\D/g, '');
    const email = (req.body.email || req.body.customer_email || 'orders@drapestore.co').trim();
    const address = (req.body.address || req.body.customer_address || '').trim();
    const pincode = (req.body.pincode || req.body.customer_pincode || '').trim();
    const cart = req.body.cart || (req.body.product_name ? [{ name: req.body.product_name, price: req.body.price, quantity: 1 }] : []);

    const customerName = String(name || 'Guest Customer');
    const customerPhone = String(phone || '').trim();
    const customerEmail = String(email || 'orders@drapestore.co');
    const customerAddress = String(address || '').trim();
    const customerPincode = String(pincode || '').trim();

    // Validate inputs
    if (!customerName || !customerPhone || !customerEmail || !customerAddress || !customerPincode) {
      return res.status(400).json({
        success: false,
        message: 'Missing required checkout fields.',
      });
    }

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Cart is empty or invalid.',
      });
    }

    // Calculate total amount server-side (security best practice)
    let totalAmount = 0;
    for (const item of cart) {
      const price = Number(item.product && item.product.price) || 0;
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
      return res.status(400).json({
        success: false,
        message: 'Cart total amount must be greater than zero.',
      });
    }

    // Insert master order into Supabase
    const shippingValue = customerAddress + ' - ' + customerPincode;
    const { data: orderRow, error: insertError } = await supabaseAdmin
      .from('orders')
      .insert([{
        customer_name: customerName,
        customer_phone: customerPhone,
        customer_email: customerEmail,
        customer_address: shippingValue,
        total_amount: totalAmount,
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

    const cleanPhone = customerPhone.length >= 10 ? customerPhone.slice(-10) : '';
    const customerId = cleanPhone.length >= 10 ? cleanPhone : 'CUST_' + Date.now();
    const customerPhoneForCashfree = cleanPhone.length >= 10 ? cleanPhone : '9999999999';

    // Prepare Cashfree order payload with calculated total
    const payload = {
      order_id: cfOrderId,
      order_amount: totalAmount.toFixed(2),
      order_currency: 'INR',
      customer_details: {
        customer_id: customerId,
        customer_phone: customerPhoneForCashfree,
        customer_email: customerEmail,
        customer_name: customerName,
      },
      order_meta: {
        return_url: CASHFREE_RETURN_URL,
      },
    };

    console.log('Sending to Cashfree:', JSON.stringify(payload, null, 2));

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

    // Return success response with payment details
    return res.status(200).json({
      success: true,
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
