/* ==========================================================================
   JS & CO — Reviews API
   Express + Mongoose + MongoDB Atlas

   Endpoints:
     GET  /api/health   – health check
     GET  /api/reviews  – public reviews (newest first)
     POST /api/reviews  – submit a review (published immediately)
   ========================================================================== */
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const Review = require("./models/Review");

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (!MONGODB_URI) {
  console.error("FATAL: MONGODB_URI is not set. Create backend/.env from .env.example.");
  process.exit(1);
}

if (/<[^>]+>/.test(MONGODB_URI)) {
  console.error(
    "FATAL: MONGODB_URI still contains placeholders. Copy the connection string from MongoDB Atlas (Connect > Drivers), replace the username/password, and use your actual cluster hostname."
  );
  process.exit(1);
}

/* ---------------- Security middleware ---------------- */
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server / curl (no origin) and any explicitly allowed origin.
      if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: "20kb" }));

// Global API rate limit
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Stricter limit for review submissions (abuse prevention)
const reviewLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many reviews submitted. Please try again later." },
});

/* ---------------- Validation helpers ---------------- */
function validateReviewPayload(body) {
  const errors = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const rating = Number(body.rating);

  if (name.length < 2 || name.length > 80) errors.push("Name must be 2–80 characters.");
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.push("Rating must be a whole number between 1 and 5.");
  if (message.length < 10 || message.length > 1000) errors.push("Message must be 10–1000 characters.");
  // Basic HTML/script tag rejection (defence in depth — output is also escaped client-side)
  if (/<script|on\w+\s*=|<iframe/i.test(name + " " + message)) errors.push("Content contains disallowed markup.");

  return { errors, name, rating, message };
}

/* ---------------- Routes ---------------- */
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    time: new Date().toISOString(),
  });
});

app.get("/api/reviews", async (req, res) => {
  try {
    const reviews = await Review.find({ status: { $ne: "rejected" } })
      .select("name rating message date -_id")
      .sort({ date: -1 })
      .limit(50)
      .lean();
    res.json(reviews);
  } catch (err) {
    console.error("GET /api/reviews error:", err);
    res.status(500).json({ message: "Failed to load reviews." });
  }
});

app.post("/api/reviews", reviewLimiter, async (req, res) => {
  try {
    const { errors, name, rating, message } = validateReviewPayload(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ message: errors.join(" "), errors });
    }
    await Review.create({ name, rating, message, status: "approved" });
    res.status(201).json({ message: "Review submitted and published." });
  } catch (err) {
    console.error("POST /api/reviews error:", err);
    res.status(500).json({ message: "Could not save your review. Please try again later." });
  }
});

/* Optional moderation endpoints — protect with a secret if you use them.
   (Not linked from the public frontend.) */
app.post("/api/reviews/:id/moderate", (req, res) => {
  const secret = req.headers["x-admin-secret"];
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ message: "Unauthorized." });
  }
  const { action } = req.body || {};
  if (!["approved", "rejected"].includes(action)) {
    return res.status(400).json({ message: "action must be 'approved' or 'rejected'." });
  }
  Review.findByIdAndUpdate(req.params.id, { status: action })
    .then((doc) =>
      doc
        ? res.json({ message: `Review ${action}.` })
        : res.status(404).json({ message: "Review not found." })
    )
    .catch(() => res.status(500).json({ message: "Moderation failed." }));
});

app.use((err, req, res, next) => {
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "Origin not allowed." });
  }
  console.error(err);
  res.status(500).json({ message: "Unexpected server error." });
});

/* ---------------- Database + start ---------------- */
mongoose
  .connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 })
  .then(() => {
    console.log("MongoDB connected.");
    app.listen(PORT, () => console.log(`JS & CO API listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });
