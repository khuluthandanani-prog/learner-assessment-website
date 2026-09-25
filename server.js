const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ==========================================
// DATABASE SETUP
// ==========================================

async function setupDatabase() {
  try {
    const sql =
      "CREATE TABLE IF NOT EXISTS users (" +
      "id SERIAL PRIMARY KEY, " +
      "name VARCHAR(150) NOT NULL, " +
      "email VARCHAR(255) UNIQUE NOT NULL, " +
      "password_hash TEXT NOT NULL, " +
      "role VARCHAR(30) NOT NULL DEFAULT 'learner', " +
      "status VARCHAR(30) NOT NULL DEFAULT 'pending', " +
      "created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP" +
      ")";

    await pool.query(sql);

    console.log("Users table is ready.");
  } catch (error) {
    console.error("Database setup failed:", error);
    throw error;
  }
}

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      success: true,
      message: "RISE COLLECTIVE backend and database are connected."
    });
  } catch (error) {
    console.error("Database connection error:", error);

    res.status(500).json({
      success: false,
      message: "Database connection failed."
    });
  }
});

// ==========================================
// REGISTER
// ==========================================

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        message: "Please complete all required fields."
      });
    }

    if (!["learner", "lecturer"].includes(role)) {
      return res.status(400).json({
        success: false,
        message: "Invalid account type."
      });
    }

    if (String(password).length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must contain at least 6 characters."
      });
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).trim().toLowerCase();

    const existing = await pool.query(
      "SELECT id, name, email, role, status FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];

      // Lecturer already exists
      if (existingUser.role === "lecturer") {
        return res.status(409).json({
          success: false,
          message:
            "This email already belongs to a lecturer/admin account. Please use Login."
        });
      }

      // Existing learner registers again
      if (
        existingUser.role === "learner" &&
        role === "learner"
      ) {
        const passwordHash = await bcrypt.hash(
          String(password),
          10
        );

        const updated = await pool.query(
          "UPDATE users SET name = $1, password_hash = $2, status = 'pending' WHERE id = $3 RETURNING id, name, email, role, status, created_at",
          [
            cleanName,
            passwordHash,
            existingUser.id
          ]
        );

        return res.status(200).json({
          success: true,
          message:
            "Your learner account has been re-registered. Please wait for your lecturer to approve your account.",
          user: updated.rows[0]
        });
      }

      return res.status(409).json({
        success: false,
        message: "This email is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(
      String(password),
      10
    );

    const status =
      role === "learner" ? "pending" : "approved";

    const result = await pool.query(
      "INSERT INTO users (name, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role, status, created_at",
      [
        cleanName,
        cleanEmail,
        passwordHash,
        role,
        status
      ]
    );

    return res.status(201).json({
      success: true,
      message:
        role === "learner"
          ? "Registration successful. Your lecturer must approve your account."
          : "Account created successfully.",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Registration error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to complete registration."
    });
  }
});

// ==========================================
// LOGIN
// ==========================================

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required."
      });
    }

    const cleanEmail = String(email)
      .trim()
      .toLowerCase();

    const result = await pool.query(
      "SELECT id, name, email, password_hash, role, status FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Wrong email or password."
      });
    }

    const user = result.rows[0];

    const passwordCorrect = await bcrypt.compare(
      String(password),
      user.password_hash
    );

    if (!passwordCorrect) {
      return res.status(401).json({
        success: false,
        message: "Wrong email or password."
      });
    }

    if (user.status === "pending") {
      return res.status(403).json({
        success: false,
        message:
          "Your account is awaiting approval by your lecturer."
      });
    }

    if (user.status === "blocked") {
      return res.status(403).json({
        success: false,
        message:
          "Your account has been blocked. Contact your lecturer."
      });
    }

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        status: user.status
      }
    });

  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to log in."
    });
  }
});

// ==========================================
// GET LEARNERS
// ==========================================

app.get("/api/users", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, email, role, status, created_at FROM users WHERE role = 'learner' ORDER BY created_at DESC"
    );

    return res.json({
      success: true,
      users: result.rows
    });

  } catch (error) {
    console.error("Load learners error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load learners."
    });
  }
});

// ==========================================
// UPDATE LEARNER STATUS
// ==========================================

app.patch("/api/users/:id/status", async (req, res) => {
  try {
    const { status } = req.body;

    if (!["approved", "blocked"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid learner status."
      });
    }

    const result = await pool.query(
      "UPDATE users SET status = $1 WHERE id = $2 AND role = 'learner' RETURNING id, name, email, role, status, created_at",
      [
        status,
        req.params.id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Learner not found."
      });
    }

    return res.json({
      success: true,
      message:
        status === "approved"
          ? "Learner approved successfully."
          : "Learner blocked successfully.",
      user: result.rows[0]
    });

  } catch (error) {
    console.error("Status update error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to update learner status."
    });
  }
});

// ==========================================
// DELETE LEARNER
// ==========================================

app.delete("/api/users/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND role = 'learner' RETURNING id",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Learner not found."
      });
    }

    return res.json({
      success: true,
      message: "Learner deleted successfully."
    });

  } catch (error) {
    console.error("Delete learner error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to delete learner."
    });
  }
});

// ==========================================
// START SERVER
// ==========================================

async function startServer() {
  try {
    await setupDatabase();

    app.listen(PORT, "0.0.0.0", function () {
      console.log("Server running on port " + PORT);
    });

  } catch (error) {
    console.error("Server startup failed:", error);
    process.exit(1);
  }
}

startServer();
