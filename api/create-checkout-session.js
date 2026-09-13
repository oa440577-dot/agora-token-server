const Stripe = require("stripe");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const { amountUsd, uid } = req.body;

  if (!amountUsd || !uid) {
    return res.status(400).json({ error: "amountUsd and uid are required" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `${amountUsd} Coin Pack` },
            unit_amount: Math.round(amountUsd * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { uid, amountUsd: String(amountUsd) },
      success_url: "https://stress-ochre.vercel.app/wallet?success=true",
      cancel_url: "https://stress-ochre.vercel.app/wallet?canceled=true",
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
};
