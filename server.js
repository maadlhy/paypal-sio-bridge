// server.js
console.log("Boot server.js...");
require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

// 🔐 CORS (ouvre à tout pendant la mise au point; en prod, mets ton domaine SIO)
app.use(cors({ origin: true }));

/* =============================
   PayPal / Systeme.io — ENV switch
   ============================= */
const ENV = (process.env.PAYPAL_ENV || "live").toLowerCase(); // "sandbox" | "live"
const IS_SANDBOX = ENV === "sandbox";

const PAYPAL_BASE = IS_SANDBOX
  ? "https://api.sandbox.paypal.com"
  : "https://api.paypal.com";

const PAYPAL_CLIENT_ID = IS_SANDBOX
  ? process.env.PAYPAL_CLIENT_ID_SANDBOX
  : process.env.PAYPAL_CLIENT_ID_LIVE;

const PAYPAL_CLIENT_SECRET = IS_SANDBOX
  ? process.env.PAYPAL_CLIENT_SECRET_SANDBOX
  : process.env.PAYPAL_CLIENT_SECRET_LIVE;

const SIO_BASE = "https://api.systeme.io/api";

/* =============================
   Helpers
   ============================= */

// Node 18+ → fetch global OK

async function paypalToken() {
  const auth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`[paypalToken] ${r.status} ${t}`);
  }
  const j = await r.json();
  return j.access_token;
}

function isCompleted(details) {
  if (details?.status === "COMPLETED") return true;
  try {
    return (
      details?.purchase_units?.[0]?.payments?.captures?.[0]?.status ===
      "COMPLETED"
    );
  } catch {
    return false;
  }
}

async function sioUpsertContact(p) {
  const headersJson = {
    "Content-Type": "application/json",
    "X-API-Key": process.env.SIO_API_KEY,
  };

  // 1) Try create
  let r = await fetch(`${SIO_BASE}/contacts`, {
    method: "POST",
    headers: headersJson,
    body: JSON.stringify({
      email: p.email,
      firstName: p.firstName || p.given_name || undefined,
      lastName: p.lastName || p.surname || undefined,
      fields: [
        { slug: "address", value: p.addressLine || null },
        { slug: "city", value: p.city || null },
        { slug: "state", value: p.state || null },
        { slug: "postal_code", value: p.postal_code || null },
        { slug: "country", value: p.country || null },
      ],
    }),
  });

  if (r.ok) return r.json();

  // 2) Fallback: get by email, then patch
  const q = await fetch(
    `${SIO_BASE}/contacts?email=${encodeURIComponent(p.email)}&limit=1`,
    { headers: { "X-API-Key": process.env.SIO_API_KEY } }
  );
  const list = await q.json();
  const contact = list.items?.[0];
  if (!contact) throw new Error("[sioUpsertContact] not found after create");

  await fetch(`${SIO_BASE}/contacts/${contact.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/merge-patch+json",
      "X-API-Key": process.env.SIO_API_KEY,
    },
    body: JSON.stringify({
      fields: [
        { slug: "address", value: p.addressLine || null },
        { slug: "city", value: p.city || null },
        { slug: "state", value: p.state || null },
        { slug: "postal_code", value: p.postal_code || null },
        { slug: "country", value: p.country || null },
      ],
    }),
  });

  return contact;
}

async function sioEnroll(contactId, courseId) {
  const r = await fetch(`${SIO_BASE}/school/courses/${courseId}/enrollments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.SIO_API_KEY,
    },
    body: JSON.stringify({ contactId }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`[sioEnroll] ${t}`);
  }
  return r.json();
}

/* =============================
   Routes
   ============================= */

app.get("/health", (_req, res) => res.json({ ok: true }));

// (Optionnel) Création d'order côté serveur — tu peux laisser vide côté front pour créer client-side
app.post("/create-paypal-order", async (req, res) => {
  try {
    const { amount, hasBump } = req.body || {};
    const total = amount || (hasBump ? "24.00" : "19.00");
    const token = await paypalToken();

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: hasBump ? "STARTER+MINI-BUNDLE" : "STARTER-ONLY",
            amount: { currency_code: "EUR", value: total },
          },
        ],
      }),
    });

    const j = await r.json();
    if (!r.ok) return res.status(400).json(j);
    return res.json({ id: j.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "create order failed" });
  }
});

// Capture + inscription SIO + retour OK → front redirige
app.post("/capture-paypal-order", async (req, res) => {
  try {
    const { orderID, expectedAmount, email } = req.body || {};
    if (!orderID) return res.status(400).json({ ok: false, msg: "orderID missing" });

    const token = await paypalToken();

    // 1) Capture PayPal
    const cap = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${orderID}/capture`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    const details = await cap.json();
    if (!cap.ok || !isCompleted(details)) {
      return res.status(400).json({ ok: false, msg: "not completed", details });
    }

    // 2) Payer / address
    const payer = details?.payer || {};
    const given_name = payer?.name?.given_name || "";
    const surname = payer?.name?.surname || "";
    const buyerEmail = email || payer?.email_address || "";
    const addr =
      details?.purchase_units?.[0]?.shipping?.address || payer?.address || {};
    const addressLine = [addr.address_line_1, addr.address_line_2]
      .filter(Boolean)
      .join(" ");
    const city = addr.admin_area_2 || "";
    const state = addr.admin_area_1 || "";
    const postal_code = addr.postal_code || "";
    const country = addr.country_code || "";

    // 3) Contact SIO
    const contact = await sioUpsertContact({
      email: buyerEmail,
      given_name,
      surname,
      addressLine,
      city,
      state,
      postal_code,
      country,
    });

    // 4) Montant payé → inscription
    const capObj =
      details?.purchase_units?.[0]?.payments?.captures?.[0] || {};
    const paid =
      capObj?.amount?.value ||
      details?.purchase_units?.[0]?.amount?.value ||
      expectedAmount ||
      "19.00";

    // (Optionnel) stricte vérif de montant
    if (expectedAmount && paid !== expectedAmount) {
      return res
        .status(400)
        .json({ ok: false, msg: "amount mismatch", paid, expectedAmount });
    }

    if (paid === "19.00") {
      await sioEnroll(contact.id, process.env.SIO_COURSE_ID_STARTER);
    } else if (paid === "24.00") {
      await sioEnroll(contact.id, process.env.SIO_COURSE_ID_STARTER);
      await sioEnroll(contact.id, process.env.SIO_COURSE_ID_MINI);
    } else {
      console.warn("[capture] Unexpected amount:", paid);
    }

    return res.json({
      ok: true,
      status: "COMPLETED",
      contactId: contact.id,
      amount: paid,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "capture/enroll failed" });
  }
});

/* =============================
   Start
   ============================= */
app.listen(3000, () => {
  console.log("Server running on :3000");
  console.log(`PayPal mode: ${IS_SANDBOX ? "SANDBOX" : "LIVE"}`);
});

