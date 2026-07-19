require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");

const { router: authRouter, requireLogin } = require("./routes/auth");
const sitesRouter = require("./routes/sites");
const filesRouter = require("./routes/files");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "change-me-to-a-long-random-string") {
  console.warn(
    "\n[WARN] SESSION_SECRET is missing or still the placeholder value.\n" +
      "       Set a real random string in .env before exposing this server.\n"
  );
}

app.set("trust proxy", 1); // needed for secure cookies when behind nginx/Caddy

app.use(express.json({ limit: "2mb" }));
app.use(
  session({
    name: "connect.sid",
    secret: process.env.SESSION_SECRET || "insecure-dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true",
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
    },
  })
);

// Public routes (login itself must not require login)
app.use("/api/auth", authRouter);

// Everything else under /api requires the web-app login
app.use("/api/sites", requireLogin, sitesRouter);
app.use("/api/files", requireLogin, filesRouter);

// Frontend
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Web File Manager listening on port " + PORT);
});
